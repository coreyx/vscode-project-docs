import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { CORE_VERSION } from "../src/index.js";

const manifest = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
) as { version: string; exports: Record<string, { source: string }> };

describe("core package", () => {
  it("exposes the version it's published as", () => {
    expect(CORE_VERSION).toBe(manifest.version);
  });

  it.each(Object.entries(manifest.exports))("entry point %s loads", async (_name, target) => {
    const module = (await import(new URL(`../${target.source}`, import.meta.url).href)) as object;
    expect(Object.keys(module).length).toBeGreaterThan(0);
  });
});
