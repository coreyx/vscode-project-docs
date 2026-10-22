/**
 * The sync scheduler (design.md, `SyncController`): the long-lived loop that decides when passes
 * run. It holds the engine lock for as long as it runs, debounces change notifications, never runs
 * two passes at once, reconciles everything on start and on a periodic rescan, and can be paused.
 * It has no VS Code dependency; the extension feeds it file-watcher events and shows its state.
 */
import { acquireLock, isLockHandle, type LockHandle, type LockInfo } from "../lock/index.js";
import { syncOnce, type Project, type SyncOutcome } from "../engine/index.js";
import type { Plan } from "../plan/index.js";
import type { StatCache } from "../scan/index.js";

/** What the scheduler is doing, for the status bar (REQ-17.0.1). */
export type SchedulerState =
  | { readonly state: "starting" }
  | { readonly state: "syncing" }
  | { readonly state: "idle" }
  /** The last pass left something for the user: conflicts, held-back changes, failures. */
  | { readonly state: "attention"; readonly count: number }
  | { readonly state: "paused" }
  /** The bulk guard stopped a pass; it waits for the user to proceed or cancel (REQ-7). */
  | { readonly state: "bulk"; readonly plan: Plan }
  /** Another window or a CLI run holds the lock (REQ-19.1). */
  | { readonly state: "elsewhere"; readonly heldBy: LockInfo | null }
  | { readonly state: "error"; readonly message: string };

/** Timer functions, injectable so tests can control time. */
export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

const realTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

/** Options for a scheduler. */
export interface SchedulerOptions {
  readonly project: Project;
  /** Shown to other windows and the CLI when this one holds the lock. */
  readonly window: string;
  /** Quiet time after the last change before a pass runs (design.md: 300 ms). */
  readonly debounceMs?: number;
  /** Full rescan interval, the safety net for missed events (REQ-4.0.3: 10 minutes). */
  readonly rescanMs?: number;
  /** How often to try for a lock held elsewhere, to take over when it goes stale. */
  readonly lockRetryMs?: number;
  readonly timers?: Timers;
  readonly onState?: (state: SchedulerState) => void;
  readonly onPass?: (outcome: SyncOutcome) => void;
}

export const DEBOUNCE_MS = 300;
export const RESCAN_MS = 10 * 60_000;
export const LOCK_RETRY_MS = 15_000;

/** Runs sync passes for one project for as long as it's started. */
export class SyncScheduler {
  private lock: LockHandle | null = null;
  private stopHeartbeat: (() => void) | null = null;
  private debounce: unknown = null;
  private rescan: unknown = null;
  private lockRetry: unknown = null;
  private running: Promise<void> | null = null;
  private rerun = false;
  private paused = false;
  private disposed = false;
  private current: SchedulerState = { state: "starting" };
  /** Hashes from earlier passes, so unchanged files aren't re-read every pass (REQ-20.0.2). */
  private readonly cache: { repo: StatCache; vault: StatCache } = {
    repo: new Map(),
    vault: new Map(),
  };
  private readonly timers: Timers;

  constructor(private readonly options: SchedulerOptions) {
    this.timers = options.timers ?? realTimers;
  }

  get state(): SchedulerState {
    return this.current;
  }

  private setState(state: SchedulerState): void {
    this.current = state;
    this.options.onState?.(state);
  }

  /** Takes the lock (or reports who holds it) and runs the first, reconciling pass (REQ-4.0.1). */
  async start(): Promise<void> {
    await this.options.project.store.ensure();
    if (!(await this.tryLock())) {
      this.lockRetry = this.timers.setInterval(
        () => void this.retryLock(),
        this.options.lockRetryMs ?? LOCK_RETRY_MS,
      );
      return;
    }
    await this.begin();
  }

  private async tryLock(): Promise<boolean> {
    const acquired = await acquireLock(this.options.project.store.dir, "vscode", {
      window: this.options.window,
    });
    if (!isLockHandle(acquired)) {
      this.setState({ state: "elsewhere", heldBy: acquired.heldBy });
      return false;
    }
    this.lock = acquired;
    this.stopHeartbeat = acquired.startHeartbeat();
    return true;
  }

  private async retryLock(): Promise<void> {
    if (this.disposed || this.lock) return;
    if (await this.tryLock()) {
      if (this.lockRetry !== null) this.timers.clearInterval(this.lockRetry);
      this.lockRetry = null;
      await this.begin();
    }
  }

  private async begin(): Promise<void> {
    this.rescan = this.timers.setInterval(() => this.notify(), this.options.rescanMs ?? RESCAN_MS);
    await this.syncNow();
  }

  /** A file changed somewhere: run a pass once things are quiet for the debounce period. */
  notify(): void {
    if (this.disposed || !this.lock || this.paused) return;
    if (this.debounce !== null) this.timers.clearTimeout(this.debounce);
    this.debounce = this.timers.setTimeout(() => {
      this.debounce = null;
      void this.syncNow();
    }, this.options.debounceMs ?? DEBOUNCE_MS);
  }

  /**
   * Runs a pass now, or right after the one in progress. `allowBulk` is the user's "Proceed" on a
   * pass the bulk guard stopped.
   */
  async syncNow(options: { allowBulk?: boolean } = {}): Promise<void> {
    if (this.disposed || !this.lock || this.paused) return;
    if (this.running) {
      this.rerun = true;
      return this.running;
    }
    this.running = this.pass(options.allowBulk ?? false).finally(() => {
      this.running = null;
    });
    await this.running;
    if (this.rerun && !this.disposed) {
      this.rerun = false;
      await this.syncNow();
    }
  }

  /** The lock was taken over (this window stalled past the stale threshold): stand back and retry. */
  private lockLost(): void {
    this.stopHeartbeat?.();
    this.stopHeartbeat = null;
    this.lock = null;
    this.setState({ state: "elsewhere", heldBy: null });
    if (this.lockRetry === null) {
      this.lockRetry = this.timers.setInterval(
        () => void this.retryLock(),
        this.options.lockRetryMs ?? LOCK_RETRY_MS,
      );
    }
  }

  private async pass(allowBulk: boolean): Promise<void> {
    const lock = this.lock;
    if (!lock) return;
    // Confirm the lock is still ours before touching files: two engines must never run at once.
    if (!(await lock.heartbeat())) {
      this.lockLost();
      return;
    }
    this.setState({ state: "syncing" });
    // A pause that arrived while this pass ran wins over the pass's own result.
    const settle = (state: SchedulerState) =>
      this.setState(this.paused ? { state: "paused" } : state);
    try {
      const outcome = await syncOnce(this.options.project, { lock, allowBulk, cache: this.cache });
      this.options.onPass?.(outcome);
      if (outcome.outcome === "bulk") settle({ state: "bulk", plan: outcome.plan });
      else if (outcome.outcome === "locked") settle({ state: "elsewhere", heldBy: outcome.heldBy });
      else {
        const count = outcome.plan.notices.length + outcome.result.failed.length;
        settle(count > 0 ? { state: "attention", count } : { state: "idle" });
      }
    } catch (error) {
      settle({
        state: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Runs `work` while holding the lock and with no pass in progress, such as writing a conflict's
   * resolution, then syncs. Throws if this window doesn't hold the lock.
   */
  async exclusive<T>(work: (project: Project) => Promise<T>): Promise<T> {
    while (this.running) await this.running;
    if (!this.lock || !(await this.lock.heartbeat())) {
      throw new Error(
        "Another window or a CLI run is syncing this project; try there, or wait for it to finish.",
      );
    }
    const run = work(this.options.project);
    this.running = run.then(
      () => undefined,
      () => undefined,
    );
    try {
      return await run;
    } finally {
      this.running = null;
      this.notify();
    }
  }

  /** Stops syncing until resumed (REQ-17.0.5). */
  /**
   * Pauses syncing. A pass already running can't be stopped halfway, so it finishes; the returned
   * promise resolves once it has, after which no pass runs until `resume`.
   */
  async pause(): Promise<void> {
    this.paused = true;
    if (this.debounce !== null) this.timers.clearTimeout(this.debounce);
    this.debounce = null;
    this.setState({ state: "paused" });
    await this.running;
  }

  /** Resumes and catches up on anything that changed while paused. */
  async resume(): Promise<void> {
    if (!this.paused) return;
    this.paused = false;
    await this.syncNow();
  }

  /** Cancels a pass the bulk guard stopped: nothing changes until the next sync (REQ-7.0.2). */
  async cancelBulk(): Promise<void> {
    await this.options.project.store.clearPendingBulk();
    this.setState({ state: "idle" });
  }

  /** Stops timers and releases the lock, so another window or the CLI can take over. */
  async dispose(): Promise<void> {
    this.disposed = true;
    for (const [handle, clear] of [
      [this.debounce, (h: unknown) => this.timers.clearTimeout(h)],
      [this.rescan, (h: unknown) => this.timers.clearInterval(h)],
      [this.lockRetry, (h: unknown) => this.timers.clearInterval(h)],
    ] as const) {
      if (handle !== null) clear(handle);
    }
    await this.running;
    this.stopHeartbeat?.();
    await this.lock?.release();
    this.lock = null;
  }
}
