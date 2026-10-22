import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import * as path from "node:path";
import { REPORT_FAILURES_AFTER, execute, replayJournal } from "../../src/exec/index.js";
import { markdownHash } from "../../src/scan/index.js";
import { statusFilePath } from "../../src/status/index.js";
import type { SideFs } from "../../src/sidefs/index.js";
import { harness, type Harness } from "./harness.js";

let h: Harness;
beforeEach(async () => {
  h = await harness();
});
afterEach(async () => {
  await h.cleanup();
});

async function status() {
  return JSON.parse(await readFile(statusFilePath(h.vault.root), "utf8"));
}

describe("a pass end to end", () => {
  it("copies both ways, records bases, and writes status", async () => {
    await h.put("repo", "a.md", "from the repo\n");
    await h.put("vault", "b.md", "from the vault\n");
    const result = await h.pass();
    expect(result).toMatchObject({ applied: 2, stale: 0, failed: [] });
    expect(await h.read("vault", "a.md")).toBe("from the repo\n");
    expect(await h.read("repo", "b.md")).toBe("from the vault\n");
    const index = await h.index();
    expect(Object.keys(index.entries).sort()).toEqual(["a.md", "b.md"]);
    expect(await h.store.getBlob(markdownHash("from the repo\n"))).not.toBeNull();
    expect(await status()).toMatchObject({ state: "idle", items: [] });
    expect(await h.store.loadJournal()).toBeNull();
    // A second pass has nothing to do.
    expect((await h.pass()).applied).toBe(0);
  });

  it("keeps each side's line endings through edits on both sides (REQ-3.2)", async () => {
    await h.put("repo", "a.md", "one\r\ntwo\r\n");
    await h.pass();
    await h.put("vault", "a.md", "one\ntwo\n");
    await h.pass(); // the vault copy now uses LF; content is unchanged
    await h.put("vault", "a.md", "one\nTWO from Obsidian\n");
    await h.pass();
    expect(await h.read("repo", "a.md")).toBe("one\r\nTWO from Obsidian\r\n");
    await h.put("repo", "a.md", "ONE from VS Code\r\nTWO from Obsidian\r\n");
    await h.pass();
    expect(await h.read("vault", "a.md")).toBe("ONE from VS Code\nTWO from Obsidian\n");
  });

  it("merges edits to different paragraphs on both sides (REQ-5.1)", async () => {
    await h.put("repo", "a.md", "one\n\ntwo\n\nthree\n\nfour\n\nfive\n");
    await h.pass();
    await h.put("repo", "a.md", "ONE\n\ntwo\n\nthree\n\nfour\n\nfive\n");
    await h.put("vault", "a.md", "one\n\ntwo\n\nthree\n\nfour\n\nFIVE\n");
    await h.pass();
    const merged = "ONE\n\ntwo\n\nthree\n\nfour\n\nFIVE\n";
    expect(await h.read("repo", "a.md")).toBe(merged);
    expect(await h.read("vault", "a.md")).toBe(merged);
  });

  it("keeps the repo version in place on a conflict and saves the vault version (REQ-5.2)", async () => {
    await h.put("repo", "a.md", "line\n");
    await h.pass();
    await h.put("repo", "a.md", "repo line\n");
    await h.put("vault", "a.md", "vault line\r\n");
    await h.pass();
    expect(await h.read("repo", "a.md")).toBe("repo line\n");
    expect(await h.read("vault", "a.md")).toBe("repo line\r\n");
    const [conflict] = await h.store.listConflicts();
    expect(conflict).toMatchObject({ key: "a.md", vaultHash: markdownHash("vault line\n") });
    const saved = await h.store.getBlob(conflict?.vaultHash ?? "");
    expect(new TextDecoder().decode(saved ?? new Uint8Array())).toBe("vault line\n");
    expect(await status()).toMatchObject({
      state: "attention",
      items: [{ kind: "conflict", path: "a.md" }],
    });
    // Blob garbage collection keeps every version a conflict needs.
    await h.pass();
    expect(await h.store.getBlob(conflict?.vaultHash ?? "")).not.toBeNull();
  });

  it("moves deleted files to each side's trash (REQ-6.3)", async () => {
    await h.put("repo", "a.md", "a\n");
    await h.put("repo", "b.md", "b\n");
    await h.pass();
    await h.remove("repo", "a.md");
    await h.remove("vault", "b.md");
    await h.pass();
    expect(await readdir(path.join(h.vaultRoot, ".trash"))).toEqual(["a.md"]);
    expect(h.repoTrash).toEqual([path.join(h.repoDir, "b.md")]);
  });

  it("renames instead of deleting and recreating (REQ-6.1)", async () => {
    await h.put("repo", "a.md", "content\n");
    await h.pass();
    await h.remove("vault", "a.md");
    await h.put("vault", "b.md", "content\n");
    await h.pass();
    expect(await h.read("repo", "a.md")).toBeNull();
    expect(await h.read("repo", "b.md")).toBe("content\n");
    expect(h.repoTrash).toEqual([]);
    expect(Object.keys((await h.index()).entries)).toEqual(["b.md"]);
  });
});

describe("re-checking before writing", () => {
  it("doesn't overwrite a target edited after planning", async () => {
    await h.put("repo", "a.md", "a\n");
    await h.pass();
    await h.put("repo", "a.md", "repo edit\n");
    const planned = await h.planOnly();
    await h.put("vault", "a.md", "vault edit made meanwhile\n");
    const result = await execute(
      planned,
      { repo: h.repo, vault: h.vault, store: h.store },
      await h.index(),
    );
    expect(result).toMatchObject({ applied: 0, stale: 1 });
    expect(await h.read("vault", "a.md")).toBe("vault edit made meanwhile\n");
  });

  it("doesn't trash a file edited after planning", async () => {
    await h.put("repo", "a.md", "a\n");
    await h.pass();
    await h.remove("repo", "a.md");
    const planned = await h.planOnly();
    await h.put("vault", "a.md", "edited before the trash happened\n");
    const result = await execute(
      planned,
      { repo: h.repo, vault: h.vault, store: h.store },
      await h.index(),
    );
    expect(result.stale).toBe(1);
    expect(await h.read("vault", "a.md")).toBe("edited before the trash happened\n");
    // The next pass sees the edit and keeps it.
    await h.pass();
    expect(await h.read("repo", "a.md")).toBe("edited before the trash happened\n");
  });

  it("skips a copy whose source changed after planning, and copies it next pass", async () => {
    await h.put("repo", "a.md", "first\n");
    const planned = await h.planOnly();
    await h.put("repo", "a.md", "second\n");
    const result = await execute(
      planned,
      { repo: h.repo, vault: h.vault, store: h.store },
      await h.index(),
    );
    expect(result.stale).toBe(1);
    expect(await h.read("vault", "a.md")).toBeNull();
    await h.pass();
    expect(await h.read("vault", "a.md")).toBe("second\n");
  });
});

describe("crash safety (REQ-19.0.3)", () => {
  it("finishes an interrupted pass from its journal", async () => {
    for (const name of ["a", "b", "c"]) await h.put("repo", `${name}.md`, `${name}\n`);
    let saves = 0;
    const crashing = Object.create(h.store) as typeof h.store;
    crashing.saveJournal = async (journal) => {
      saves++;
      // The journal is saved once before the first action and once after each; dying on the
      // third save leaves a journal saying one action is done.
      if (saves === 3) throw new Error("simulated crash");
      return h.store.saveJournal(journal);
    };
    await expect(
      execute(
        await h.planOnly(),
        { repo: h.repo, vault: h.vault, store: crashing },
        await h.index(),
      ),
    ).rejects.toThrow("simulated crash");
    expect(await h.store.loadJournal()).not.toBeNull();

    const replayed = await replayJournal(
      { repo: h.repo, vault: h.vault, store: h.store },
      await h.index(),
    );
    expect(replayed).not.toBeNull();
    for (const name of ["a", "b", "c"])
      expect(await h.read("vault", `${name}.md`)).toBe(`${name}\n`);
    expect(await h.store.loadJournal()).toBeNull();
    expect(Object.keys((await h.index()).entries).sort()).toEqual(["a.md", "b.md", "c.md"]);
  });

  it("has nothing to replay when no pass was interrupted", async () => {
    expect(
      await replayJournal({ repo: h.repo, vault: h.vault, store: h.store }, await h.index()),
    ).toBeNull();
  });

  it("drops a journal it can't read and replans instead", async () => {
    await h.store.saveJournal({ format: 99, actions: "?" });
    expect(
      await replayJournal({ repo: h.repo, vault: h.vault, store: h.store }, await h.index()),
    ).toBeNull();
    expect(await h.store.loadJournal()).toBeNull();
  });
});

describe("failed writes", () => {
  it("retries each pass and reports a write that keeps failing (TASK-14)", async () => {
    await h.put("repo", "locked.md", "x\n");
    const failingVault: SideFs = {
      ...h.vault,
      writeAtomic: async () => {
        throw Object.assign(new Error("permission denied"), { code: "EACCES" });
      },
    };
    for (let i = 1; i <= REPORT_FAILURES_AFTER; i++) {
      const result = await h.pass({ vault: failingVault });
      expect(result.failed).toEqual([
        { key: "locked.md", message: "permission denied", consecutive: i },
      ]);
    }
    expect((await status()).items).toContainEqual(
      expect.objectContaining({ kind: "write-failing", path: "locked.md" }),
    );
    // Once the write works, the count resets.
    await h.pass();
    expect(await h.read("vault", "locked.md")).toBe("x\n");
    expect(await h.store.loadFailures()).toEqual({});
  });
});

describe("status", () => {
  it("never contains a real value", async () => {
    h.mapping = new Map([["myhost", "DESK-FAKE01"]]);
    await h.put("repo", "a.md", "a\n");
    await h.pass();
    await h.put("vault", "a.md", "ssh DESK-FAKE01\n");
    await h.pass();
    const text = await readFile(statusFilePath(h.vault.root), "utf8");
    expect(text).toContain("held-back");
    expect(text.toLowerCase()).not.toContain("desk-fake01");
    expect(await h.read("repo", "a.md")).toBe("a\n");
  });
});
