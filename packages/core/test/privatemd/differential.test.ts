/**
 * Differential test: the TypeScript decoder against the standard's Python reference implementation
 * (vendored in ./reference), on generated inputs. Any disagreement is a bug in one of them, and
 * becomes a new conformance case in the standard once understood. Skipped where no Python 3.10+
 * is available.
 */
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { PrivateMdError, parsePlaceholders, restore } from "../../src/privatemd/index.js";

const REFERENCE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "reference");

function findPython(): string | null {
  for (const candidate of ["python3", "python"]) {
    const result = spawnSync(candidate, ["-c", "import sys; print(sys.version_info >= (3, 10))"], {
      encoding: "utf8",
    });
    if (result.status === 0 && result.stdout.trim() === "True") return candidate;
  }
  return null;
}

/** A small deterministic generator, so a failure reproduces from its case number. */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PLACEHOLDERS = [
  "myhost",
  "myhost.lan",
  "example.ts.net",
  ".internal",
  "100.64.0.1",
  "100.64.0.10",
  "café",
  "a `b`",
  "١٢٣",
  "nas",
  "x_y",
];
const FRAGMENTS = [
  ...PLACEHOLDERS,
  "not",
  "s",
  "é",
  "ß",
  "中",
  "٣",
  "_",
  "-",
  ".",
  "/",
  " ",
  "\n",
  "\r\n",
  "\r",
  "😀",
  "`",
  "0",
  "<!-- public-only -->\n",
  "<!-- /public-only -->\n",
  "<!-- public-only -->\r\n",
  "<!-- /public-only -->\r\n",
];
const REALS = ["DESK-FAKE01", "fake-otter.ts.net", "10.0.0.1", "gw-myhost", "`tick`", "", "x"];

interface Case {
  readonly mapping: string;
  readonly text: string;
}

function generate(count: number): Case[] {
  const random = prng(20261022);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
  const cases: Case[] = [];
  for (let i = 0; i < count; i++) {
    const rows: string[] = [];
    const rowCount = 1 + Math.floor(random() * 4);
    for (let r = 0; r < rowCount; r++) {
      const placeholder = pick(PLACEHOLDERS);
      const real = pick(REALS);
      const cell = (value: string) => (value.includes("`") ? `\`\` ${value} \`\`` : `\`${value}\``);
      rows.push(`| ${cell(placeholder)} | ${cell(real)} | row ${r} |`);
    }
    const mapping = `## Placeholders\n\n| P | R | What |\n| --- | --- | --- |\n${rows.join("\n")}\n`;
    let text = "";
    const length = Math.floor(random() * 30);
    for (let f = 0; f < length; f++) text += pick(FRAGMENTS);
    cases.push({ mapping, text });
  }
  return cases;
}

// The driver reads the cases as JSON bytes and writes results as JSON bytes, so no newline
// translation happens on any platform.
const DRIVER = `
import json, sys, tempfile, pathlib
sys.path.insert(0, sys.argv[1])
import private_md
cases = json.loads(sys.stdin.buffer.read().decode("utf-8"))
results = []
with tempfile.TemporaryDirectory() as folder:
    for case in cases:
        file = pathlib.Path(folder) / "PRIVATE.md"
        file.write_bytes(case["mapping"].encode("utf-8"))
        try:
            results.append({"ok": private_md.restore(case["text"], private_md.load_placeholders(file))})
        except private_md.PrivateMdError as error:
            results.append({"error": error.kind})
sys.stdout.buffer.write(json.dumps(results).encode("utf-8"))
`;

function decodeInTypeScript(c: Case): { ok: string } | { error: string } {
  try {
    return { ok: restore(c.text, parsePlaceholders(c.mapping)) };
  } catch (error) {
    if (error instanceof PrivateMdError) return { error: error.kind };
    throw error;
  }
}

const python = findPython();

describe("decoder agrees with the Python reference implementation", () => {
  it.skipIf(python === null)(
    "on 500 generated cases",
    () => {
      const cases = generate(500);
      const result = spawnSync(python ?? "", ["-I", "-c", DRIVER, REFERENCE_DIR], {
        input: Buffer.from(JSON.stringify(cases), "utf8"),
        maxBuffer: 64 * 1024 * 1024,
      });
      expect(result.status, result.stderr.toString()).toBe(0);
      const expected = JSON.parse(result.stdout.toString("utf8")) as unknown[];
      const disagreements = cases
        .map((c, i) => ({ i, c, ts: decodeInTypeScript(c), py: expected[i] }))
        .filter(({ ts, py }) => JSON.stringify(ts) !== JSON.stringify(py));
      expect(disagreements.slice(0, 3)).toEqual([]);
      // Starting Python takes several seconds on Windows CI runners.
    },
    60_000,
  );
});
