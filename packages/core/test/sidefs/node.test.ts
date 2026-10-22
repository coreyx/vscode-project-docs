import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  TargetExistsError,
  createNodeSideFs,
  isTempName,
  vaultTrash,
  type SideFs,
  type TrashFn,
} from "../../src/sidefs/index.js";
import { probeCaseInsensitive } from "../../src/paths/index.js";

let root: string;
let fs: SideFs;
const trashed: string[] = [];
const recordTrash: TrashFn = async (p) => {
  trashed.push(p);
  await rm(p);
};

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "pd-sidefs-"));
  trashed.length = 0;
  fs = createNodeSideFs({
    side: "repo",
    root,
    isWindowsFs: process.platform === "win32",
    caseInsensitive: await probeCaseInsensitive(root),
    trash: recordTrash,
  });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function collect(skip?: (key: string) => boolean) {
  const entries = [];
  for await (const entry of fs.list(skip)) entries.push(entry);
  return entries.sort((a, b) => (a.key < b.key ? -1 : 1));
}

describe("list", () => {
  it("lists files recursively by key", async () => {
    await mkdir(path.join(root, "guides", "deep"), { recursive: true });
    await writeFile(path.join(root, "a.md"), "a");
    await writeFile(path.join(root, "guides", "deep", "b.md"), "bb");
    const entries = await collect();
    expect(entries.map((e) => [e.key, e.kind, e.size])).toEqual([
      ["a.md", "file", 1],
      ["guides/deep/b.md", "file", 2],
    ]);
  });

  it("skips folders the caller excludes", async () => {
    await mkdir(path.join(root, ".obsidian"));
    await writeFile(path.join(root, ".obsidian", "app.json"), "{}");
    await writeFile(path.join(root, "a.md"), "a");
    expect((await collect((key) => key === ".obsidian")).map((e) => e.key)).toEqual(["a.md"]);
  });

  it("reports a link to a folder without following it (REQ-16.0.5)", async () => {
    const target = await mkdtemp(path.join(tmpdir(), "pd-target-"));
    try {
      await writeFile(path.join(target, "secret.md"), "x");
      // Junctions need no special privileges on Windows; elsewhere this is an ordinary symlink.
      await symlink(target, path.join(root, "linked"), "junction");
      const entries = await collect();
      expect(entries.map((e) => [e.key, e.kind])).toEqual([["linked", "symlink"]]);
    } finally {
      await rm(target, { recursive: true, force: true });
    }
  });

  it("returns nothing for a folder that doesn't exist yet", async () => {
    const missing = createNodeSideFs({
      side: "vault",
      root: path.join(root, "missing"),
      isWindowsFs: false,
      caseInsensitive: false,
      trash: recordTrash,
    });
    const entries = [];
    for await (const entry of missing.list()) entries.push(entry);
    expect(entries).toEqual([]);
  });
});

describe("writeAtomic", () => {
  it("creates parent folders and leaves no temporary file", async () => {
    await fs.writeAtomic("new/folder/a.md", new TextEncoder().encode("hello"));
    expect(await readFile(path.join(root, "new", "folder", "a.md"), "utf8")).toBe("hello");
    expect((await readdir(path.join(root, "new", "folder"))).filter(isTempName)).toEqual([]);
  });

  it("never lets a concurrent reader see a partial file (REQ-3.3)", async () => {
    const size = 256 * 1024;
    const a = new Uint8Array(size).fill(0x61);
    const b = new Uint8Array(size).fill(0x62);
    await fs.writeAtomic("busy.md", a);
    let writing = true;
    let reads = 0;
    const bad: string[] = [];
    const reader = (async () => {
      while (writing) {
        try {
          const data = await readFile(path.join(root, "busy.md"));
          reads++;
          const first = data[0];
          if (data.length !== size || !data.every((byte) => byte === first)) {
            bad.push(`length ${data.length}`);
          }
        } catch (error) {
          // Windows can refuse a read while the file is being replaced; that's not a partial read.
          const code = (error as NodeJS.ErrnoException).code ?? "";
          if (!["EBUSY", "EPERM", "EACCES", "ENOENT"].includes(code)) throw error;
        }
        // Still far more often than any editor reads a file. On Windows, where an open file blocks
        // the rename and virus scanning slows every write, a shorter pause starves the writer on
        // CI runners.
        await new Promise((resolve) => setTimeout(resolve, process.platform === "win32" ? 20 : 1));
      }
    })();
    // Windows can't rename over a file another process has open, so against a reader this
    // relentless a write occasionally runs out of retries. The engine treats that as a failed
    // write and retries on the next pass; what must never happen is a partial read.
    let failedWrites = 0;
    for (let i = 0; i < 1000; i++) {
      try {
        await fs.writeAtomic("busy.md", i % 2 ? a : b);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code ?? "";
        if (process.platform !== "win32" || !["EPERM", "EBUSY", "EACCES"].includes(code)) {
          throw error;
        }
        failedWrites++;
      }
    }
    writing = false;
    await reader;
    expect(bad).toEqual([]);
    expect(reads).toBeGreaterThan(0);
    expect(failedWrites).toBeLessThan(50);
  }, 300_000);
});

describe("rename", () => {
  it("moves a file, creating the target folder", async () => {
    await writeFile(path.join(root, "a.md"), "a");
    await fs.rename("a.md", "archive/b.md");
    expect(await fs.exists("a.md")).toBe(false);
    expect(await readFile(path.join(root, "archive", "b.md"), "utf8")).toBe("a");
  });

  it("refuses to overwrite another file", async () => {
    await writeFile(path.join(root, "a.md"), "a");
    await writeFile(path.join(root, "b.md"), "b");
    await expect(fs.rename("a.md", "b.md")).rejects.toBeInstanceOf(TargetExistsError);
    expect(await readFile(path.join(root, "b.md"), "utf8")).toBe("b");
  });

  it("changes only the case of a name (REQ-6.2)", async () => {
    await writeFile(path.join(root, "Readme.md"), "r");
    await fs.rename("Readme.md", "README.md");
    expect(await readdir(root)).toEqual(["README.md"]);
  });
});

describe("trash", () => {
  it("hands the absolute path to the side's trash", async () => {
    await writeFile(path.join(root, "a.md"), "a");
    await fs.trash("a.md");
    expect(trashed).toEqual([path.join(root, "a.md")]);
    expect(await fs.exists("a.md")).toBe(false);
  });

  it("retries while Windows reports the file busy", async () => {
    let attempts = 0;
    const flaky = createNodeSideFs({
      side: "repo",
      root,
      isWindowsFs: false,
      caseInsensitive: false,
      trash: async () => {
        attempts++;
        if (attempts < 3) throw Object.assign(new Error("busy"), { code: "EBUSY" });
      },
    });
    await flaky.trash("a.md");
    expect(attempts).toBe(3);
  });

  it("gives up on errors that aren't transient", async () => {
    const failing = createNodeSideFs({
      side: "repo",
      root,
      isWindowsFs: false,
      caseInsensitive: false,
      trash: async () => {
        throw Object.assign(new Error("gone"), { code: "ENOENT" });
      },
    });
    await expect(failing.trash("a.md")).rejects.toThrow("gone");
  });
});

describe("vaultTrash", () => {
  it("moves files into the vault's .trash, renaming on a clash (REQ-6.3)", async () => {
    const vault = root;
    await mkdir(path.join(vault, "Projects", "repo"), { recursive: true });
    const first = path.join(vault, "Projects", "repo", "note.md");
    await writeFile(first, "one");
    const trash = vaultTrash(vault, () => new Date("2026-10-22T12:00:00.000Z"));
    await trash(first);
    await writeFile(first, "two");
    await trash(first);
    const inTrash = (await readdir(path.join(vault, ".trash"))).sort();
    expect(inTrash).toEqual(["note 2026-10-22T12-00-00-000Z.md", "note.md"]);
    expect(await readFile(path.join(vault, ".trash", "note.md"), "utf8")).toBe("one");
  });
});
