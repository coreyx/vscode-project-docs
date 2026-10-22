import { describe, expect, it } from "vitest";
import * as path from "node:path";
import fc from "fast-check";
import { RULE_CHOICES, minimalEdit, ruleKey, ruleStatusText } from "../../src/rules/choices.js";

describe("RULE_CHOICES (REQ-9.0.2)", () => {
  it("offers sync, repo-to-vault and repo-only in VS Code, but not private", () => {
    expect(RULE_CHOICES.map((c) => c.rule)).toEqual(["sync", "repo-to-vault", "repo-only"]);
  });
});

describe("ruleKey", () => {
  it("gives the key of a Markdown file in the docs folder", () => {
    expect(ruleKey("/r/docs/guides/a.md", "/r/docs", path.posix)).toBe("guides/a.md");
    expect(
      ruleKey(
        path.win32.join("C:\\", "r", "docs", "guides", "A.MD"),
        path.win32.join("C:\\", "r", "docs"),
        path.win32,
      ),
    ).toBe("guides/A.MD");
  });

  it("is null for other files", () => {
    expect(ruleKey("/r/README.md", "/r/docs", path.posix)).toBeNull();
    expect(ruleKey("/r/docs/image.png", "/r/docs", path.posix)).toBeNull();
    expect(ruleKey("/r/docs-old/a.md", "/r/docs", path.posix)).toBeNull();
    expect(
      ruleKey(
        path.win32.join("D:\\", "elsewhere", "a.md"),
        path.win32.join("C:\\", "r", "docs"),
        path.win32,
      ),
    ).toBeNull();
  });
});

describe("ruleStatusText (REQ-9.0.1)", () => {
  it("names the rule, and says when it's invalid", () => {
    expect(ruleStatusText("repo-only").text).toBe("$(circle-slash) repo-only");
    expect(ruleStatusText("sync").tooltip).toContain("Click to change it");
    expect(ruleStatusText({ invalid: true, value: "x", message: "bad" })).toEqual({
      text: "$(warning) invalid rule",
      tooltip: "Project Docs: bad",
    });
  });
});

describe("minimalEdit", () => {
  it("replaces only the differing middle", () => {
    expect(minimalEdit("a: 1\nb: 2\n", "a: 1\nb: 3\n")).toEqual({ start: 8, end: 9, text: "3" });
    expect(minimalEdit("same", "same")).toEqual({ start: 4, end: 4, text: "" });
  });

  it("always turns before into after", () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (before, after) => {
        const { start, end, text } = minimalEdit(before, after);
        expect(before.slice(0, start) + text + before.slice(end)).toBe(after);
      }),
    );
  });
});
