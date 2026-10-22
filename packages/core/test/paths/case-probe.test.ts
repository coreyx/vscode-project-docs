import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { probeCaseInsensitive } from "../../src/paths/index.js";

// GitHub's Windows and macOS runners use case-insensitive filesystems by default; Linux and the
// WSL filesystem are case-sensitive. A Windows drive seen from WSL is case-insensitive too.
const expected = process.platform === "win32" || process.platform === "darwin";

describe("probeCaseInsensitive", () => {
  it("matches the platform's default filesystem and writes nothing", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pd-case-"));
    try {
      const folder = path.join(root, "Docs");
      await mkdir(folder);
      expect(await probeCaseInsensitive(folder)).toBe(expected);
      expect(await readdir(folder)).toEqual([]);
      expect(await readdir(root)).toEqual(["Docs"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("walks up past a folder name with no letters", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pd-case-"));
    try {
      const folder = path.join(root, "2026");
      await mkdir(folder);
      expect(await probeCaseInsensitive(folder)).toBe(expected);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  const windowsDir = process.env["PROJECT_DOCS_TEST_WINDOWS_DIR"];
  it.runIf(windowsDir)("reports a Windows drive seen from WSL as case-insensitive", async () => {
    const folder = await mkdtemp(path.join(windowsDir ?? "", "Probe-"));
    try {
      expect(await probeCaseInsensitive(folder)).toBe(true);
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });
});
