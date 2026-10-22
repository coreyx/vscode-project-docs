import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { isIgnoredChange, startNativeWatch } from "../../src/watch/index.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "pd-native-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("isIgnoredChange", () => {
  it("ignores the engine's metadata, Obsidian's config and trash, git and temp files", () => {
    for (const p of [
      ".project-docs/status.json",
      ".obsidian/workspace.json",
      ".trash/old.md",
      "sub\\.git\\index",
      "notes/.a.md.pd-tmp-0a1b",
    ]) {
      expect(isIgnoredChange(p)).toBe(true);
    }
  });

  it("keeps ordinary notes", () => {
    expect(isIgnoredChange("guides/setup.md")).toBe(false);
    expect(isIgnoredChange("project-docs.md")).toBe(false);
  });
});

describe("startNativeWatch", () => {
  async function changesFrom(write: () => Promise<void>): Promise<number> {
    let count = 0;
    const stop = startNativeWatch(root, () => count++);
    expect(stop).not.toBeNull();
    try {
      await new Promise((resolve) => setTimeout(resolve, 100));
      await write();
      await new Promise((resolve) => setTimeout(resolve, 500));
      return count;
    } finally {
      stop?.();
    }
  }

  it("reports a change in a nested folder", async () => {
    await mkdir(path.join(root, "deep", "er"), { recursive: true });
    expect(
      await changesFrom(() => writeFile(path.join(root, "deep", "er", "note.md"), "x")),
    ).toBeGreaterThan(0);
  });

  it("stays quiet about the engine's own status file", async () => {
    await mkdir(path.join(root, ".project-docs"));
    expect(
      await changesFrom(() => writeFile(path.join(root, ".project-docs", "status.json"), "{}")),
    ).toBe(0);
  });
});
