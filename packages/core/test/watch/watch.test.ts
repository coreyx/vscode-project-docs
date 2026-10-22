import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { acquireLock, isLockHandle } from "../../src/lock/index.js";
import { createNodeSideFs } from "../../src/sidefs/index.js";
import {
  SyncScheduler,
  diffListings,
  startPolling,
  type SchedulerState,
} from "../../src/watch/index.js";
import { linkedProject, type LinkedProject } from "./project.js";

let linked: LinkedProject;
const schedulers: SyncScheduler[] = [];

beforeEach(async () => {
  linked = await linkedProject();
});
afterEach(async () => {
  for (const s of schedulers.splice(0)) await s.dispose();
  await linked.cleanup();
});

/** Waits until `check` passes or the time runs out. */
async function eventually(check: () => Promise<boolean>, ms: number): Promise<number> {
  const started = Date.now();
  while (Date.now() - started < ms) {
    if (await check()) return Date.now() - started;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`not within ${ms} ms`);
}

const fileIs = (file: string, text: string) => async () => {
  try {
    return (await readFile(file, "utf8")).replace(/\r\n/g, "\n") === text;
  } catch {
    return false;
  }
};

async function scheduler(
  window: string,
  states: SchedulerState[] = [],
  options: { rescanMs?: number; lockRetryMs?: number } = {},
) {
  const s = new SyncScheduler({
    project: await linked.open(),
    window,
    debounceMs: 20,
    rescanMs: options.rescanMs ?? 60_000,
    lockRetryMs: options.lockRetryMs ?? 60_000,
    onState: (state) => states.push(state),
  });
  schedulers.push(s);
  return s;
}

describe("diffListings", () => {
  it("reports added, changed and removed keys", () => {
    const before = new Map([
      ["a.md", "1:1"],
      ["b.md", "1:1"],
      ["c.md", "1:1"],
    ]);
    const after = new Map([
      ["a.md", "1:1"],
      ["b.md", "2:2"],
      ["d.md", "1:1"],
    ]);
    expect(diffListings(before, after)).toEqual(["b.md", "c.md", "d.md"]);
  });
});

describe("startPolling (REQ-4.0.2)", () => {
  it("notices a change within one interval, without reading files", async () => {
    const fs = createNodeSideFs({
      side: "vault",
      root: linked.vaultFolder,
      isWindowsFs: false,
      caseInsensitive: false,
      trash: async () => {},
    });
    const seen: string[][] = [];
    const stop = startPolling(fs, { intervalMs: 50, onChange: (keys) => seen.push(keys) });
    try {
      await new Promise((resolve) => setTimeout(resolve, 80));
      await writeFile(path.join(linked.vaultFolder, "new.md"), "x");
      await eventually(async () => seen.length > 0, 2_000);
      expect(seen[0]).toEqual(["new.md"]);
    } finally {
      stop();
    }
  });

  const windowsDir = process.env["PROJECT_DOCS_TEST_WINDOWS_DIR"];
  it.runIf(windowsDir)(
    "notices a change on a Windows drive from WSL within 10 seconds (REQ-4.2)",
    async () => {
      const onWindows = await linkedProject(windowsDir);
      try {
        const fs = createNodeSideFs({
          side: "vault",
          root: onWindows.vaultFolder,
          isWindowsFs: true,
          caseInsensitive: true,
          trash: async () => {},
        });
        const seen: string[][] = [];
        const stop = startPolling(fs, { onChange: (keys) => seen.push(keys) });
        try {
          await new Promise((resolve) => setTimeout(resolve, 500));
          await writeFile(path.join(onWindows.vaultFolder, "from-windows.md"), "x");
          const took = await eventually(async () => seen.length > 0, 10_000);
          expect(took).toBeLessThan(10_000);
        } finally {
          stop();
        }
      } finally {
        await onWindows.cleanup();
      }
    },
    20_000,
  );
});

describe("SyncScheduler", () => {
  it("reconciles on start, then syncs each change after the debounce (REQ-3.1, REQ-4.1)", async () => {
    await writeFile(path.join(linked.docs, "edited-while-closed.md"), "offline edit\n");
    const s = await scheduler("w1");
    await s.start();
    expect(
      await fileIs(path.join(linked.vaultFolder, "edited-while-closed.md"), "offline edit\n")(),
    ).toBe(true);

    await writeFile(path.join(linked.vaultFolder, "from-obsidian.md"), "hello\n");
    s.notify();
    const took = await eventually(
      fileIs(path.join(linked.docs, "from-obsidian.md"), "hello\n"),
      2_000,
    );
    expect(took).toBeLessThan(2_000);
    await eventually(async () => s.state.state === "idle", 2_000);
  });

  it("catches a change no watcher reported on the periodic rescan (REQ-4.3)", async () => {
    const s = await scheduler("w1", [], { rescanMs: 100 });
    await s.start();
    await writeFile(path.join(linked.docs, "unreported.md"), "missed by the watcher\n");
    await eventually(
      fileIs(path.join(linked.vaultFolder, "unreported.md"), "missed by the watcher\n"),
      3_000,
    );
  });

  it("lets one window sync and tells the other it's handled elsewhere (REQ-19.1)", async () => {
    const first = await scheduler("window one");
    await first.start();
    const states: SchedulerState[] = [];
    const second = await scheduler("window two", states, { lockRetryMs: 50 });
    await second.start();
    expect(second.state).toMatchObject({ state: "elsewhere", heldBy: { window: "window one" } });
    // When the first window closes, the second takes over.
    await first.dispose();
    await eventually(async () => second.state.state === "idle", 3_000);
  });

  it("stands back if its lock is taken over, and doesn't sync without it", async () => {
    const s = await scheduler("w1", [], { lockRetryMs: 60_000 });
    await s.start();
    // Another engine takes over, as if this window had stalled past the stale threshold.
    const project = await linked.open();
    await s["lock"]?.release();
    const thief = await acquireLock(project.store.dir, "cli");
    expect(isLockHandle(thief)).toBe(true);
    await writeFile(path.join(linked.docs, "after.md"), "x\n");
    await s.syncNow();
    expect(s.state.state).toBe("elsewhere");
    expect(await fileIs(path.join(linked.vaultFolder, "after.md"), "x\n")()).toBe(false);
    if (isLockHandle(thief)) await thief.release();
  });

  it("pauses and resumes (REQ-17.0.5)", async () => {
    const s = await scheduler("w1");
    await s.start();
    s.pause();
    expect(s.state).toEqual({ state: "paused" });
    await writeFile(path.join(linked.docs, "while-paused.md"), "p\n");
    s.notify();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await fileIs(path.join(linked.vaultFolder, "while-paused.md"), "p\n")()).toBe(false);
    await s.resume();
    expect(await fileIs(path.join(linked.vaultFolder, "while-paused.md"), "p\n")()).toBe(true);
  });

  it("waits at the bulk guard until told to proceed or cancel (REQ-7)", async () => {
    for (let i = 0; i < 30; i++) await writeFile(path.join(linked.docs, `d${i}.md`), `${i}\n`);
    const s = await scheduler("w1");
    await s.start();
    const { rm } = await import("node:fs/promises");
    for (let i = 0; i < 25; i++) await rm(path.join(linked.docs, `d${i}.md`));
    await s.syncNow();
    expect(s.state.state).toBe("bulk");
    expect(await fileIs(path.join(linked.vaultFolder, "d0.md"), "0\n")()).toBe(true);
    await s.cancelBulk();
    expect(s.state).toEqual({ state: "idle" });
    await s.syncNow({ allowBulk: true });
    expect(await fileIs(path.join(linked.vaultFolder, "d0.md"), "0\n")()).toBe(false);
  });

  it("reports attention when a pass leaves something for the user", async () => {
    await writeFile(path.join(linked.vaultFolder, "bad.md"), "---\nproject-docs: typo\n---\n");
    const s = await scheduler("w1");
    await s.start();
    expect(s.state).toEqual({ state: "attention", count: 1 });
  });

  it("runs one pass at a time, and another after if changes arrived meanwhile", async () => {
    const s = await scheduler("w1");
    await s.start();
    await writeFile(path.join(linked.docs, "one.md"), "1\n");
    const a = s.syncNow();
    await writeFile(path.join(linked.docs, "two.md"), "2\n");
    const b = s.syncNow();
    await Promise.all([a, b]);
    expect(await fileIs(path.join(linked.vaultFolder, "two.md"), "2\n")()).toBe(true);
  });
});
