/**
 * Benchmark for REQ-20.0.1: the first sync of 1,000 Markdown files of 50 KB each must finish in
 * under 30 seconds. It's enforced on Linux, the CI reference runner; on Windows and macOS the time
 * is reported but doesn't fail the build, since their CI disks (and Windows' virus scanning) vary
 * too much to be a fair reference. It runs in CI, or locally with PROJECT_DOCS_BENCH=1.
 */
import { describe, expect, it } from "vitest";
import { writeFile } from "node:fs/promises";
import * as path from "node:path";
import { harness } from "../exec/harness.js";

const FILES = 1000;
const SIZE = 50 * 1024;
const LIMIT_MS = 30_000;
const enabled = Boolean(process.env["CI"] || process.env["PROJECT_DOCS_BENCH"]);

/** About 50 KB of Markdown, different per file so nothing is deduplicated. */
function document(n: number): string {
  const lines: string[] = [`# Document ${n}`, ""];
  let size = 0;
  for (let i = 0; size < SIZE; i++) {
    const line = `Paragraph ${i} of document ${n}: some ordinary prose to make the file realistically sized.`;
    lines.push(line, "");
    size += line.length + 2;
  }
  return `${lines.join("\n")}\n`;
}

describe("first sync performance (REQ-20.1)", () => {
  it.runIf(enabled)(
    `syncs ${FILES} files of 50 KB in under ${LIMIT_MS / 1000} s`,
    async () => {
      const h = await harness();
      try {
        for (let i = 0; i < FILES; i++) {
          await writeFile(
            path.join(h.repoDir, `doc-${String(i).padStart(4, "0")}.md`),
            document(i),
          );
        }
        const started = performance.now();
        const result = await h.pass();
        const elapsed = performance.now() - started;
        console.log(
          `first sync of ${FILES} files on ${process.platform}: ${(elapsed / 1000).toFixed(1)} s`,
        );
        expect(result.applied).toBe(FILES);
        if (process.platform === "linux") expect(elapsed).toBeLessThan(LIMIT_MS);
      } finally {
        await h.cleanup();
      }
    },
    600_000,
  );
});
