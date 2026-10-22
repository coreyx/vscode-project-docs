import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { LOG_FILE, createFileLogger, createRedactor } from "../../src/log/index.js";

const mapping = new Map([
  ["example.ts.net", "fake-otter-0000.ts.net"],
  ["myhost", "DESK-FAKE01"],
  ["100.64.0.1", "100.99.12.34"],
  ["ab", "xy"],
]);

describe("createRedactor", () => {
  it("replaces real values in any case with their placeholders (REQ-17.3)", () => {
    const redact = createRedactor(mapping);
    expect(redact("synced from desk-fake01 to Fake-Otter-0000.TS.net via 100.99.12.34")).toBe(
      "synced from myhost to example.ts.net via 100.64.0.1",
    );
  });

  it("hides a real value even inside a longer word", () => {
    expect(createRedactor(mapping)("host=DESK-FAKE01x")).toBe("host=myhostx");
  });

  it("replaces the longest real value first", () => {
    const nested = new Map([
      ["short", "otter"],
      ["long", "fake-otter-0000"],
    ]);
    expect(createRedactor(nested)("at fake-otter-0000 and otter")).toBe("at long and short");
  });

  it("leaves values shorter than 4 characters alone", () => {
    expect(createRedactor(mapping)("xylophone")).toBe("xylophone");
  });

  it("escapes regular-expression characters in real values", () => {
    const special = new Map([["p", "a+b(c)"]]);
    expect(createRedactor(special)("x a+b(c) y aab")).toBe("x p y aab");
  });

  it("passes text through when there's no mapping", () => {
    expect(createRedactor(null)("DESK-FAKE01")).toBe("DESK-FAKE01");
    expect(createRedactor(new Map())("DESK-FAKE01")).toBe("DESK-FAKE01");
    expect(createRedactor(new Map([["ab", "xy"]]))("xy")).toBe("xy");
  });
});

describe("createFileLogger", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "pd-log-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("writes only placeholders, one line per entry", async () => {
    const logger = createFileLogger({
      dir: path.join(dir, "log"),
      mapping: () => mapping,
      now: () => new Date("2026-10-22T12:00:00.000Z"),
    });
    await logger.info("copied notes about DESK-FAKE01\nto the vault");
    await logger.warn("held back: desk-fake01 in setup.md");
    await logger.error("failed on 100.99.12.34");
    const text = await readFile(path.join(dir, "log", LOG_FILE), "utf8");
    expect(text).toBe(
      "2026-10-22T12:00:00.000Z INFO copied notes about myhost to the vault\n" +
        "2026-10-22T12:00:00.000Z WARN held back: myhost in setup.md\n" +
        "2026-10-22T12:00:00.000Z ERROR failed on 100.64.0.1\n",
    );
    expect(text.toLowerCase()).not.toContain("desk-fake01");
  });

  it("reads the mapping at each write, so a new PRIVATE.md row applies at once", async () => {
    let current: Map<string, string> | null = null;
    const logger = createFileLogger({ dir, mapping: () => current });
    await logger.info("before DESK-FAKE01");
    current = mapping;
    await logger.info("after DESK-FAKE01");
    const text = await readFile(path.join(dir, LOG_FILE), "utf8");
    expect(text).toContain("before DESK-FAKE01");
    expect(text).toContain("after myhost");
  });

  it("rotates the file, keeping a bounded number of old ones", async () => {
    const logger = createFileLogger({ dir, mapping: () => null, maxBytes: 100, keep: 2 });
    for (let i = 0; i < 20; i++) await logger.info(`entry ${i} ${"x".repeat(40)}`);
    expect((await readdir(dir)).sort()).toEqual([LOG_FILE, `${LOG_FILE}.1`, `${LOG_FILE}.2`]);
  });

  it("keeps lines from concurrent calls whole", async () => {
    const logger = createFileLogger({ dir, mapping: () => null });
    await Promise.all(Array.from({ length: 50 }, (_, i) => logger.info(`line ${i}`)));
    const lines = (await readFile(path.join(dir, LOG_FILE), "utf8")).trimEnd().split("\n");
    expect(lines).toHaveLength(50);
    expect(lines.every((line) => / INFO line \d+$/.test(line))).toBe(true);
  });
});
