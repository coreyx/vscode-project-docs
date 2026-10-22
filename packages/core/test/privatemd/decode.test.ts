import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PrivateMdError,
  findRealValues,
  loadPlaceholders,
  parseCodeSpan,
  parsePlaceholders,
  placeholderPattern,
  replaceRealValues,
  restore,
} from "../../src/privatemd/index.js";

const CASES = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "conformance", "cases");

describe("conformance (REQ-14.1)", async () => {
  const names = (await readdir(CASES)).sort();

  it("has the standard's cases", () => {
    expect(names.length).toBeGreaterThanOrEqual(15);
  });

  for (const name of names) {
    it(name, async () => {
      const folder = path.join(CASES, name);
      // Bytes in, bytes out: the cases include CRLF on purpose.
      const mappingText = (await readFile(path.join(folder, "mapping.md"))).toString("utf8");
      const input = (await readFile(path.join(folder, "input.md"))).toString("utf8");
      const files = await readdir(folder);
      if (files.includes("error.txt")) {
        const kind = (await readFile(path.join(folder, "error.txt"), "utf8")).trim();
        let raised: unknown;
        try {
          restore(input, parsePlaceholders(mappingText));
        } catch (error) {
          raised = error;
        }
        expect(raised).toBeInstanceOf(PrivateMdError);
        expect((raised as PrivateMdError).kind).toBe(kind);
      } else {
        const expected = await readFile(path.join(folder, "expected.md"));
        const output = Buffer.from(restore(input, parsePlaceholders(mappingText)), "utf8");
        expect(output.equals(expected)).toBe(true);
      }
    });
  }
});

describe("parseCodeSpan", () => {
  it.each([
    ["`myhost`", "myhost"],
    [" `myhost` ", "myhost"],
    ["`` `whoami` ``", "`whoami`"],
    ["`` a `b` ``", "a `b`"],
    ["`  `", "  "],
    ["myhost", null],
    ["`a` `b`", "a` `b"],
  ])("%j -> %j", (cell, expected) => {
    expect(parseCodeSpan(cell)).toBe(expected);
  });
});

describe("parsePlaceholders", () => {
  it("reads rows under the heading in order", () => {
    const mapping = parsePlaceholders(
      "# Notes\n\n## Placeholders\n\n| P | R |\n| --- | --- |\n| `b` | `2` |\n| `a` | `1` |\n",
    );
    expect([...mapping]).toEqual([
      ["b", "2"],
      ["a", "1"],
    ]);
  });

  it("skips a row whose placeholder is empty rather than failing", () => {
    expect([...parsePlaceholders("## Placeholders\n| `` | `x` |\n| `a` | `1` |\n")]).toEqual([
      ["a", "1"],
    ]);
  });

  it("names the source in errors", () => {
    expect(() => parsePlaceholders("nothing", "repo/PRIVATE.md")).toThrow(
      "repo/PRIVATE.md: no '## Placeholders' section",
    );
  });
});

describe("loadPlaceholders", () => {
  it("reads a file, and reports a missing one as the standard says", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pd-pmd-"));
    try {
      const file = path.join(dir, "PRIVATE.md");
      await writeFile(file, "## Placeholders\n| `myhost` | `DESK-FAKE01` |\n");
      expect([...(await loadPlaceholders(file))]).toEqual([["myhost", "DESK-FAKE01"]]);
      await rm(file);
      await expect(loadPlaceholders(file)).rejects.toMatchObject({
        kind: "missing-file",
        message: expect.stringContaining("restore it from wherever you keep it"),
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("restore details", () => {
  it("doesn't treat a lone carriage return as a line start for public-only markers", () => {
    const mapping = new Map([["x", "y"]]);
    expect(restore("a\r<!-- public-only -->\nb\n<!-- /public-only -->\n", mapping)).toBe(
      "a\r<!-- public-only -->\nb\n<!-- /public-only -->\n",
    );
  });

  it("uses code points for a placeholder's ends", () => {
    // An emoji is not a letter or digit, so no boundary applies at that end.
    expect(placeholderPattern("😀host")).toBe("😀host(?![\\p{L}\\p{N}])");
    expect(restore("x😀hostz 😀host.", new Map([["😀host", "R"]]))).toBe("x😀hostz R.");
  });

  it("only drops public-only blocks when there are no placeholders", () => {
    expect(restore("a\n<!-- public-only -->\nb\n<!-- /public-only -->\nc\n", new Map())).toBe(
      "a\nc\n",
    );
  });
});

const mapping = new Map([
  ["example.ts.net", "fake-otter-0000.ts.net"],
  ["myhost", "DESK-FAKE01"],
  ["ab", "xy"],
]);

describe("findRealValues", () => {
  it("finds real values in any case, naming placeholders only", () => {
    const findings = findRealValues("ssh desk-fake01\nok\nhttps://FAKE-OTTER-0000.ts.net", mapping);
    expect(findings).toEqual([
      { line: 1, placeholder: "myhost" },
      { line: 3, placeholder: "example.ts.net" },
    ]);
    expect(JSON.stringify(findings).toLowerCase()).not.toContain("desk-fake01");
  });

  it("ignores real values shorter than 4 characters", () => {
    expect(findRealValues("xy", mapping)).toEqual([]);
    expect(findRealValues("anything", new Map([["a", "xy"]]))).toEqual([]);
  });
});

describe("replaceRealValues (REQ-13.3)", () => {
  it("replaces real values in any case with their placeholders", () => {
    expect(
      replaceRealValues("ssh DESK-FAKE01 via desk-fake01.fake-otter-0000.ts.net", mapping),
    ).toBe("ssh myhost via myhost.example.ts.net");
  });

  it("leaves an occurrence inside a longer word for the user, since replacing it could corrupt it", () => {
    const text = "DESK-FAKE01x";
    expect(replaceRealValues(text, mapping)).toBe(text);
    expect(findRealValues(text, mapping)).toHaveLength(1);
  });

  it("replaces the longest real value first", () => {
    const nested = new Map([
      ["short", "otter-0000"],
      ["long", "fake-otter-0000"],
    ]);
    expect(replaceRealValues("fake-otter-0000 otter-0000", nested)).toBe("long short");
  });

  it("applies no boundary at an end that is punctuation", () => {
    const punctuated = new Map([[".internal", ".corp.lan"]]);
    expect(replaceRealValues("host.corp.lan and host.CORP.LANx", punctuated)).toBe(
      "host.internal and host.CORP.LANx",
    );
    const bracketed = new Map([["(host)", "(DESK)"]]);
    expect(replaceRealValues("x(desk)y", bracketed)).toBe("x(host)y");
  });

  it("returns the text unchanged when no real value is long enough", () => {
    expect(replaceRealValues("xy", new Map([["ab", "xy"]]))).toBe("xy");
  });
});
