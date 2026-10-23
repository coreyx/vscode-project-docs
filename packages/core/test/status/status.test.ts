import { describe, expect, it } from "vitest";
import * as path from "node:path";
import { parsePrivateFilesList } from "../../src/guards/index.js";
import {
  confirmationsPath,
  parseConfirmations,
  parseStatusFile,
  privateFilesPath,
  serializeConfirmations,
  serializePrivateFilesList,
  serializeStatusFile,
  statusFilePath,
} from "../../src/status/index.js";

const item = {
  kind: "held-back",
  path: "notes/setup.md",
  message: "notes/setup.md isn't synced to the repo until this is fixed",
  reasons: ["contains the real value of {{HOST}}"],
  fix: "replace-real-values",
};

describe("vault metadata paths", () => {
  it("puts both files in the hidden metadata folder", () => {
    const folder = path.join("vault", "Projects", "api");
    expect(statusFilePath(folder)).toBe(path.join(folder, ".project-docs", "status.json"));
    expect(privateFilesPath(folder)).toBe(path.join(folder, ".project-docs", "private-files.json"));
  });
});

describe("status.json", () => {
  it("round-trips what the engine writes", () => {
    const text = serializeStatusFile({
      updatedAt: "2026-10-22T12:00:00.000Z",
      state: "attention",
      items: [item],
    });
    expect(text.endsWith("\n")).toBe(true);
    expect(parseStatusFile(text)).toEqual({
      format: 1,
      updatedAt: "2026-10-22T12:00:00.000Z",
      state: "attention",
      items: [item],
    });
  });

  it("treats a missing file as no status", () => {
    expect(parseStatusFile(null)).toBeNull();
  });

  it.each([
    ["unparseable JSON", "{"],
    ["a newer format", JSON.stringify({ format: 2, updatedAt: "x", state: "idle", items: [] })],
    ["no timestamp", JSON.stringify({ format: 1, state: "idle", items: [] })],
    ["an unknown state", JSON.stringify({ format: 1, updatedAt: "x", state: "busy", items: [] })],
    [
      "items that aren't a list",
      JSON.stringify({ format: 1, updatedAt: "x", state: "idle", items: {} }),
    ],
    [
      "an item without reasons",
      JSON.stringify({
        format: 1,
        updatedAt: "x",
        state: "attention",
        items: [{ kind: "k", path: "p", message: "m" }],
      }),
    ],
    [
      "a fix that isn't text",
      JSON.stringify({
        format: 1,
        updatedAt: "x",
        state: "attention",
        items: [{ ...item, fix: 1 }],
      }),
    ],
    ["null", "null"],
  ])("rejects %s", (_name, text) => {
    expect(parseStatusFile(text)).toBeNull();
  });
});

describe("private-files.json", () => {
  it("writes a list the engine reads back, sorted by path", () => {
    const text = serializePrivateFilesList([
      { path: "private/b.png", sha256: "bb" },
      { path: "private/a.png", sha256: "aa" },
    ]);
    expect(JSON.parse(text)).toEqual({
      format: 1,
      files: [
        { path: "private/a.png", sha256: "aa" },
        { path: "private/b.png", sha256: "bb" },
      ],
    });
    const list = parsePrivateFilesList(text);
    expect(list).not.toBe("invalid");
    if (list === "invalid") return;
    expect([...list.paths]).toEqual(["private/a.png", "private/b.png"]);
    expect([...list.hashes]).toEqual(["aa", "bb"]);
  });

  it("keeps only the recorded fields", () => {
    const extra = { path: "x.png", sha256: "cc", note: "dropped" };
    expect(JSON.parse(serializePrivateFilesList([extra])).files).toEqual([
      { path: "x.png", sha256: "cc" },
    ]);
  });
});

describe("confirmations.json", () => {
  it("round-trips what the plugin writes, sorted by path", () => {
    const text = serializeConfirmations([
      { path: "b.md", sha256: "bb" },
      { path: "a.md", sha256: "aa" },
    ]);
    expect(parseConfirmations(text)).toEqual([
      { path: "a.md", sha256: "aa" },
      { path: "b.md", sha256: "bb" },
    ]);
  });

  it.each([
    ["a missing file", null],
    ["unparseable JSON", "{"],
    ["another format", JSON.stringify({ format: 2, files: [{ path: "a.md", sha256: "aa" }] })],
    ["files that aren't a list", JSON.stringify({ format: 1, files: {} })],
  ])("confirms nothing for %s", (_name, text) => {
    expect(parseConfirmations(text)).toEqual([]);
  });

  it("skips malformed records and keeps the rest", () => {
    const text = JSON.stringify({
      format: 1,
      files: [{ path: "a.md", sha256: "aa" }, { path: "b.md" }, null, { sha256: "cc" }],
    });
    expect(parseConfirmations(text)).toEqual([{ path: "a.md", sha256: "aa" }]);
  });

  it("lives beside the other shared files", () => {
    const folder = path.join("vault", "p");
    expect(confirmationsPath(folder)).toBe(
      path.join(folder, ".project-docs", "confirmations.json"),
    );
  });
});
