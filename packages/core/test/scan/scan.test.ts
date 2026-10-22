import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  MAX_MARKDOWN_BYTES,
  applyLineEnding,
  decodeUtf8,
  detectLineEnding,
  markdownHash,
  scan,
  sha256,
  toLf,
  type StatCache,
} from "../../src/scan/index.js";
import { createNodeSideFs, type SideFs } from "../../src/sidefs/index.js";

let root: string;
let fs: SideFs;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "pd-scan-"));
  fs = createNodeSideFs({
    side: "vault",
    root,
    isWindowsFs: false,
    caseInsensitive: false,
    trash: async () => undefined,
  });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function put(key: string, content: string | Uint8Array) {
  const full = path.join(root, ...key.split("/"));
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, content);
}

describe("content helpers", () => {
  it("detects line endings, by majority when mixed", () => {
    expect(detectLineEnding("a\nb\n")).toBe("lf");
    expect(detectLineEnding("a\r\nb\r\n")).toBe("crlf");
    expect(detectLineEnding("a\r\nb\r\nc\n")).toBe("crlf");
    expect(detectLineEnding("a\nb\nc\r\n")).toBe("lf");
    expect(detectLineEnding("no breaks")).toBe("none");
  });

  it("converts between LF and CRLF", () => {
    expect(toLf("a\r\nb\r\n")).toBe("a\nb\n");
    expect(applyLineEnding("a\nb\n", "crlf")).toBe("a\r\nb\r\n");
    expect(applyLineEnding("a\nb\n", "lf")).toBe("a\nb\n");
    expect(applyLineEnding("a\nb\n", "none")).toBe("a\nb\n");
  });

  it("hashes Markdown the same whatever its line endings", () => {
    expect(markdownHash("a\r\nb\r\n")).toBe(markdownHash("a\nb\n"));
    expect(markdownHash("a\nb\n")).toBe(sha256("a\nb\n"));
  });

  it("decodes only valid UTF-8", () => {
    expect(decodeUtf8(new TextEncoder().encode("café"))).toBe("café");
    expect(decodeUtf8(Uint8Array.from([0x63, 0x61, 0x66, 0xe9]))).toBeNull();
  });
});

describe("scan", () => {
  it("snapshots Markdown with hashes and line endings", async () => {
    await put("a.md", "one\r\ntwo\r\n");
    await put("guides/b.MD", "b\n");
    const snapshot = await scan(fs, { includeAttachments: false });
    expect(snapshot.side).toBe("vault");
    expect([...snapshot.entries.keys()].sort()).toEqual(["a.md", "guides/b.MD"]);
    expect(snapshot.entries.get("a.md")).toMatchObject({
      kind: "markdown",
      hash: markdownHash("one\ntwo\n"),
      lineEnding: "crlf",
      isLinkNote: false,
    });
    expect(snapshot.skipped).toEqual([]);
  });

  it("never lists files that must not sync (REQ-3.4)", async () => {
    await put("PRIVATE.md", "x");
    await put("PRIVATE.example.md", "x");
    await put("notes.private.md", "x");
    await put("deep/setup.PRIVATE.md", "x");
    await put(".project-docs.json", "{}");
    await put("a.md.pd-tmp-abc", "x");
    await put(".project-docs/status.json", "{}");
    await put(".obsidian/app.json", "{}");
    await put(".trash/old.md", "x");
    await put("kept.md", "x");
    const snapshot = await scan(fs, { includeAttachments: true });
    expect([...snapshot.entries.keys()]).toEqual(["kept.md"]);
    expect(snapshot.skipped).toEqual([]);
  });

  it("skips and reports Markdown that isn't UTF-8 (REQ-16.4)", async () => {
    await put("latin1.md", Uint8Array.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));
    const snapshot = await scan(fs, { includeAttachments: false });
    expect(snapshot.entries.size).toBe(0);
    expect(snapshot.skipped).toEqual([
      expect.objectContaining({ key: "latin1.md", reason: "not-utf8" }),
    ]);
  });

  it("skips and reports Markdown over 5 MB (REQ-20.3)", async () => {
    await put("big.md", "x".repeat(6 * 1024 * 1024));
    await put("limit.md", "x".repeat(MAX_MARKDOWN_BYTES));
    const snapshot = await scan(fs, { includeAttachments: false });
    expect([...snapshot.entries.keys()]).toEqual(["limit.md"]);
    expect(snapshot.skipped).toEqual([
      expect.objectContaining({ key: "big.md", reason: "too-large" }),
    ]);
  });

  it("reports a symbolic link or junction without following it", async () => {
    const target = await mkdtemp(path.join(tmpdir(), "pd-scan-target-"));
    try {
      await writeFile(path.join(target, "inside.md"), "x");
      await symlink(target, path.join(root, "linked"), "junction");
      const snapshot = await scan(fs, { includeAttachments: false });
      expect(snapshot.entries.size).toBe(0);
      expect(snapshot.skipped.map((s) => [s.key, s.reason])).toEqual([["linked", "symlink"]]);
    } finally {
      await rm(target, { recursive: true, force: true });
    }
  });

  it("leaves attachments out unless asked, and hashes their raw bytes", async () => {
    await put("diagram.png", Uint8Array.from([1, 2, 3]));
    expect((await scan(fs, { includeAttachments: false })).entries.size).toBe(0);
    const snapshot = await scan(fs, { includeAttachments: true });
    expect(snapshot.entries.get("diagram.png")).toMatchObject({
      kind: "attachment",
      hash: sha256(Uint8Array.from([1, 2, 3])),
      lineEnding: "none",
    });
  });

  it("marks the link note", async () => {
    await put("repo/repo.md", "---\nproject-docs-id: x\n---\n");
    const snapshot = await scan(fs, { includeAttachments: false, linkNoteKey: "repo/repo.md" });
    expect(snapshot.entries.get("repo/repo.md")?.isLinkNote).toBe(true);
  });

  it("reuses cached hashes for unchanged files and forgets removed ones", async () => {
    await put("a.md", "a");
    await put("b.md", "b");
    const cache: StatCache = new Map();
    await scan(fs, { includeAttachments: false, cache });
    expect([...cache.keys()].sort()).toEqual(["a.md", "b.md"]);

    // Poison the cached hash: if the scanner re-read the file, the poison would disappear.
    const cached = cache.get("a.md");
    if (!cached) throw new Error("expected a cache entry");
    cache.set("a.md", { ...cached, hash: "from-cache" });
    await rm(path.join(root, "b.md"));
    const snapshot = await scan(fs, { includeAttachments: false, cache });
    expect(snapshot.entries.get("a.md")?.hash).toBe("from-cache");
    expect([...cache.keys()]).toEqual(["a.md"]);

    // A changed modification time forces a re-hash.
    const later = new Date(Date.now() + 60_000);
    await utimes(path.join(root, "a.md"), later, later);
    const rescanned = await scan(fs, { includeAttachments: false, cache });
    expect(rescanned.entries.get("a.md")?.hash).toBe(markdownHash("a"));
  });
});
