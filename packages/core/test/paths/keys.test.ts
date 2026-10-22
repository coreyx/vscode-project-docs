import { describe, expect, it } from "vitest";
import * as path from "node:path";
import {
  InvalidKeyError,
  absoluteFromKey,
  findCaseClashes,
  foldKey,
  isCaseOnlyChange,
  keyFromAbsolute,
  toKey,
} from "../../src/paths/index.js";

describe("toKey", () => {
  it("uses forward slashes whichever separator was given", () => {
    expect(toKey("guides\\setup\\intro.md")).toBe("guides/setup/intro.md");
    expect(toKey("guides/setup/intro.md")).toBe("guides/setup/intro.md");
  });

  it("drops empty and current-folder segments", () => {
    expect(toKey("./guides//intro.md")).toBe("guides/intro.md");
  });

  it("normalizes to NFC so macOS's decomposed names match the other side", () => {
    expect(toKey("cafe\u0301.md")).toBe("caf\u00e9.md");
  });

  it.each([
    ["/etc/passwd"],
    ["C:\\docs\\a.md"],
    ["c:/docs"],
    ["../outside.md"],
    ["a/../../b"],
    [""],
    ["./"],
  ])("rejects %j", (input) => {
    expect(() => toKey(input)).toThrow(InvalidKeyError);
  });
});

describe("absolute paths", () => {
  it("round-trips a key through the platform's separator", () => {
    const root = path.resolve("linked");
    const absolute = absoluteFromKey(root, "guides/intro.md");
    expect(absolute).toBe(path.join(root, "guides", "intro.md"));
    expect(keyFromAbsolute(root, absolute)).toBe("guides/intro.md");
  });
});

describe("case handling", () => {
  it("folds case", () => {
    expect(foldKey("Docs/README.md")).toBe("docs/readme.md");
  });

  it("finds Plan.md and plan.md as a clash (REQ-16.3)", () => {
    expect(
      findCaseClashes(["Plan.md", "plan.md", "other.md", "a/X.md", "a/x.md", "a/x.md"]),
    ).toEqual([
      ["Plan.md", "plan.md"],
      ["a/X.md", "a/x.md"],
    ]);
  });

  it("returns no clashes for distinct names", () => {
    expect(findCaseClashes(["a.md", "b.md"])).toEqual([]);
  });

  it("recognizes a case-only rename (REQ-6.2)", () => {
    expect(isCaseOnlyChange("Readme.md", "README.md")).toBe(true);
    expect(isCaseOnlyChange("README.md", "README.md")).toBe(false);
    expect(isCaseOnlyChange("a.md", "b.md")).toBe(false);
  });
});
