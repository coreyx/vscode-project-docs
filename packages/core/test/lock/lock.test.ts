import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import * as path from "node:path";
import {
  acquireLock,
  isLockHandle,
  processIsAlive,
  type LockHandle,
  type LockHeldBy,
} from "../../src/lock/index.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "pd-lock-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
});

function held(result: LockHandle | LockHeldBy): LockHandle {
  if (!isLockHandle(result)) throw new Error("expected to hold the lock");
  return result;
}

/** Starts a separate Node process that just waits, to stand in for another engine. */
function startOtherProcess(): Promise<{ pid: number; kill: () => Promise<void> }> {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("spawn", () =>
      resolve({
        pid: child.pid ?? -1,
        kill: () =>
          new Promise((done) => {
            child.once("exit", () => done());
            child.kill();
          }),
      }),
    );
  });
}

async function writeForeignLock(pid: number, heartbeatAt: Date) {
  await writeFile(
    path.join(dir, "lock.json"),
    JSON.stringify({
      pid,
      host: hostname(),
      owner: "vscode",
      window: "window-1",
      token: "other",
      heartbeatAt: heartbeatAt.toISOString(),
    }),
  );
}

describe("acquireLock", () => {
  it("lets one engine hold the lock and refuses another, naming the holder (REQ-19.1)", async () => {
    const first = held(await acquireLock(dir, "vscode", { window: "window-1" }));
    const second = await acquireLock(dir, "cli");
    expect(isLockHandle(second)).toBe(false);
    expect((second as LockHeldBy).heldBy).toMatchObject({ owner: "vscode", window: "window-1" });
    await first.release();
    held(await acquireLock(dir, "cli"));
  });

  it("refuses while another live process holds a fresh lock", async () => {
    const other = await startOtherProcess();
    try {
      await writeForeignLock(other.pid, new Date());
      const result = await acquireLock(dir, "cli");
      expect(isLockHandle(result)).toBe(false);
    } finally {
      await other.kill();
    }
  });

  it("takes over a lock whose holder has exited", async () => {
    const other = await startOtherProcess();
    await writeForeignLock(other.pid, new Date());
    await other.kill();
    expect(processIsAlive(other.pid)).toBe(false);
    const handle = held(await acquireLock(dir, "cli"));
    expect(handle.info.pid).toBe(process.pid);
    await handle.release();
  });

  it("takes over a lock whose heartbeat is older than the stale threshold", async () => {
    await writeForeignLock(process.pid, new Date("2026-10-22T12:00:00.000Z"));
    const handle = held(
      await acquireLock(dir, "cli", { now: () => new Date("2026-10-22T12:00:31.000Z") }),
    );
    expect(handle.info.owner).toBe("cli");
  });

  it("keeps a lock whose heartbeat is recent", async () => {
    await writeForeignLock(process.pid, new Date("2026-10-22T12:00:00.000Z"));
    const result = await acquireLock(dir, "cli", {
      now: () => new Date("2026-10-22T12:00:20.000Z"),
    });
    expect(isLockHandle(result)).toBe(false);
  });

  it("waits out an unreadable lock until it's old enough to be abandoned", async () => {
    const file = path.join(dir, "lock.json");
    await writeFile(file, "");
    expect(isLockHandle(await acquireLock(dir, "cli"))).toBe(false);
    const old = new Date(Date.now() - 60_000);
    await utimes(file, old, old);
    held(await acquireLock(dir, "cli"));
  });

  it("treats a foreign host's lock as live until its heartbeat goes stale", async () => {
    await writeFile(
      path.join(dir, "lock.json"),
      JSON.stringify({
        pid: 999999,
        host: "another-machine",
        owner: "cli",
        token: "x",
        heartbeatAt: new Date().toISOString(),
      }),
    );
    expect(isLockHandle(await acquireLock(dir, "vscode", { isAlive: () => false }))).toBe(false);
  });
});

describe("lock handle", () => {
  it("refreshes its heartbeat while it holds the lock", async () => {
    let clock = new Date("2026-10-22T12:00:00.000Z");
    const handle = held(await acquireLock(dir, "vscode", { now: () => clock }));
    clock = new Date("2026-10-22T12:00:10.000Z");
    expect(await handle.heartbeat()).toBe(true);
    const onDisk = JSON.parse(await readFile(path.join(dir, "lock.json"), "utf8"));
    expect(onDisk.heartbeatAt).toBe("2026-10-22T12:00:10.000Z");
  });

  it("notices when it has been taken over, and doesn't release the successor's lock", async () => {
    const first = held(await acquireLock(dir, "vscode", { window: "a" }));
    // Simulate the first holder freezing long enough for a second engine to take over.
    const later = new Date(Date.now() + 60_000);
    const second = held(await acquireLock(dir, "cli", { now: () => later }));
    expect(await first.heartbeat()).toBe(false);
    await first.release();
    expect(JSON.parse(await readFile(path.join(dir, "lock.json"), "utf8")).token).toBe(
      second.info.token,
    );
  });

  it("never recreates the lock file with a heartbeat that overlaps the release", async () => {
    const handle = held(await acquireLock(dir, "vscode"));
    const beats = [handle.heartbeat(), handle.heartbeat()];
    await handle.release();
    const after = handle.heartbeat();
    await Promise.all(beats);
    expect(await after).toBe(false);
    await expect(readFile(path.join(dir, "lock.json"), "utf8")).rejects.toThrow();
  });

  it("heartbeats on a timer until stopped", async () => {
    const handle = held(await acquireLock(dir, "vscode"));
    const before = handle.info.heartbeatAt;
    const stop = handle.startHeartbeat(20);
    await new Promise((resolve) => setTimeout(resolve, 120));
    stop();
    expect(handle.info.heartbeatAt >= before).toBe(true);
    await handle.release();
  });
});
