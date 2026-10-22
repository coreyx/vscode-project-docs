/**
 * The engine lock: at most one sync engine per link, across VS Code windows and CLI runs, released
 * automatically if its holder dies (REQ-19.0.1, design.md `lock/`).
 *
 * The lock is a `lock.json` in the project's state folder, created with exclusive-create so only
 * one process can make it. The holder rewrites its heartbeat every few seconds; a lock whose
 * heartbeat is too old, or whose process is gone, is stale and can be taken over.
 */
import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { hostname } from "node:os";
import * as path from "node:path";
import { writeFileAtomic } from "../sidefs/index.js";

/** Which program holds the lock, so a refused caller can say who (REQ-18.0.2). */
export type LockOwner = "vscode" | "cli";

/** What's recorded in `lock.json`. */
export interface LockInfo {
  readonly pid: number;
  readonly host: string;
  readonly owner: LockOwner;
  /** Distinguishes VS Code windows, for "Sync handled by another window". */
  readonly window?: string | undefined;
  /** Random per acquisition, so a holder can tell its own lock from a successor's. */
  readonly token: string;
  readonly heartbeatAt: string;
}

/** A held lock. */
export interface LockHandle {
  readonly info: LockInfo;
  /** Refreshes the heartbeat; returns false if the lock was taken over meanwhile. */
  heartbeat(): Promise<boolean>;
  /** Starts refreshing the heartbeat on a timer; returns a function that stops it. */
  startHeartbeat(intervalMs?: number): () => void;
  /** Releases the lock if this process still holds it. */
  release(): Promise<void>;
}

/** The lock is held by someone else. */
export interface LockHeldBy {
  readonly heldBy: LockInfo | null;
}

/** Options for `acquireLock`, mostly for tests. */
export interface AcquireOptions {
  readonly window?: string | undefined;
  /** How long after its last heartbeat a lock counts as abandoned. */
  readonly staleAfterMs?: number;
  readonly now?: () => Date;
  /** Whether a process on this host is still running. */
  readonly isAlive?: (pid: number) => boolean;
}

/** Default heartbeat interval; well inside the default stale threshold. */
export const HEARTBEAT_INTERVAL_MS = 10_000;
/** Default stale threshold (tasks.md TASK-6). */
export const STALE_AFTER_MS = 30_000;

/** True when a process with this id exists on this machine. */
export function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Type guard separating a held lock from a refusal. */
export function isLockHandle(result: LockHandle | LockHeldBy): result is LockHandle {
  return "release" in result;
}

async function readInfo(file: string): Promise<LockInfo | null> {
  try {
    const value = JSON.parse(await readFile(file, "utf8")) as Partial<LockInfo>;
    if (typeof value.pid !== "number" || typeof value.token !== "string") return null;
    return value as LockInfo;
  } catch {
    return null;
  }
}

/** Tries to take the lock in `stateDir`, taking over a stale one. */
export async function acquireLock(
  stateDir: string,
  owner: LockOwner,
  options: AcquireOptions = {},
): Promise<LockHandle | LockHeldBy> {
  const now = options.now ?? (() => new Date());
  const staleAfterMs = options.staleAfterMs ?? STALE_AFTER_MS;
  const isAlive = options.isAlive ?? processIsAlive;
  const file = path.join(stateDir, "lock.json");
  await mkdir(stateDir, { recursive: true });

  const makeInfo = (): LockInfo => ({
    pid: process.pid,
    host: hostname(),
    owner,
    window: options.window,
    token: randomBytes(8).toString("hex"),
    heartbeatAt: now().toISOString(),
  });

  const isStale = async (holder: LockInfo | null): Promise<boolean> => {
    if (holder === null) {
      // Unreadable: possibly mid-creation by another process. Only treat it as abandoned once it
      // has sat untouched for the stale period.
      const info = await stat(file).catch(() => null);
      return info !== null && now().getTime() - info.mtimeMs > staleAfterMs;
    }
    if (now().getTime() - Date.parse(holder.heartbeatAt) > staleAfterMs) return true;
    return holder.host === hostname() && !isAlive(holder.pid);
  };

  for (let attempt = 0; attempt < 3; attempt++) {
    const info = makeInfo();
    try {
      const handle = await open(file, "wx");
      try {
        await handle.writeFile(JSON.stringify(info));
      } finally {
        await handle.close();
      }
      return makeHandle(file, info, now);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const holder = await readInfo(file);
    if (!(await isStale(holder))) return { heldBy: holder };
    // Take over by renaming the stale lock away. Rename is atomic, so if two processes race for
    // the same stale lock only one rename succeeds; the other retries and finds the new lock.
    const graveyard = `${file}.stale-${randomBytes(4).toString("hex")}`;
    try {
      await rename(file, graveyard);
      await rm(graveyard, { force: true });
    } catch {
      // Someone else took it over first; loop to look again.
    }
  }
  return { heldBy: await readInfo(file) };
}

function makeHandle(file: string, initial: LockInfo, now: () => Date): LockHandle {
  let info = initial;
  const stillOurs = async () => (await readInfo(file))?.token === info.token;

  const handle: LockHandle = {
    get info() {
      return info;
    },
    async heartbeat() {
      if (!(await stillOurs())) return false;
      info = { ...info, heartbeatAt: now().toISOString() };
      await writeFileAtomic(file, JSON.stringify(info));
      return true;
    },
    startHeartbeat(intervalMs = HEARTBEAT_INTERVAL_MS) {
      const timer = setInterval(() => {
        void handle.heartbeat().catch(() => undefined);
      }, intervalMs);
      timer.unref();
      return () => clearInterval(timer);
    },
    async release() {
      if (await stillOurs()) await rm(file, { force: true });
    },
  };
  return handle;
}
