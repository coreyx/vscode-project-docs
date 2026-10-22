import { describe, expect, it } from "vitest";
import { hasConflictMarkers, mergeText } from "../../src/merge/index.js";

const paragraphs = (...items: string[]) => items.join("\n\n") + "\n";

describe("mergeText", () => {
  it("combines edits to different paragraphs (REQ-5.1)", () => {
    const base = paragraphs("one", "two", "three", "four", "five");
    const repo = paragraphs("ONE from VS Code", "two", "three", "four", "five");
    const vault = paragraphs("one", "two", "three", "four", "FIVE from Obsidian");
    expect(mergeText(base, repo, vault)).toEqual({
      clean: true,
      text: paragraphs("ONE from VS Code", "two", "three", "four", "FIVE from Obsidian"),
    });
  });

  it("combines identical edits", () => {
    expect(mergeText("a\nb\n", "a\nB\n", "a\nB\n")).toEqual({ clean: true, text: "a\nB\n" });
  });

  it("reports edits to the same line as a conflict, with markers for the fallback (REQ-5.2)", () => {
    const result = mergeText("a\nb\nc\n", "a\nrepo\nc\n", "a\nvault\nc\n");
    expect(result.clean).toBe(false);
    if (result.clean) return;
    expect(result.hunks).toEqual([{ repo: ["repo"], base: ["b"], vault: ["vault"] }]);
    expect(result.markedText).toBe(
      "a\n<<<<<<< repo\nrepo\n||||||| base\nb\n=======\nvault\n>>>>>>> vault\nc\n",
    );
    expect(hasConflictMarkers(result.markedText)).toBe(true);
  });

  it("ignores line endings: CRLF on one side merges with LF on the other", () => {
    expect(mergeText("a\nb\nc\n", "A\r\nb\r\nc\r\n", "a\nb\nC\n")).toEqual({
      clean: true,
      text: "A\nb\nC\n",
    });
  });

  it("handles empty files and a missing final line break", () => {
    expect(mergeText("", "", "added\n")).toEqual({ clean: true, text: "added\n" });
    expect(mergeText("a", "a\nb", "z\na")).toEqual({ clean: true, text: "z\na\nb" });
    expect(mergeText("x", "x\n", "x")).toEqual({ clean: true, text: "x\n" });
  });

  it("reports both sides adding different text to an empty base as a conflict", () => {
    expect(mergeText("", "repo text\n", "vault text\n").clean).toBe(false);
  });
});

describe("hasConflictMarkers", () => {
  it("recognizes marker lines only at the start of a line", () => {
    expect(hasConflictMarkers("a\n=======\nb")).toBe(true);
    expect(hasConflictMarkers("a\r\n>>>>>>> vault\r\n")).toBe(true);
    expect(hasConflictMarkers("text ======= text\n<<<<<<<<< longer")).toBe(false);
    expect(hasConflictMarkers("clean\n")).toBe(false);
  });
});
