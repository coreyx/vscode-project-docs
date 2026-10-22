import { describe, expect, it } from "vitest";
import { checkPortable } from "../../src/paths/index.js";

describe("checkPortable on a Windows target", () => {
  it("rejects notes:draft.md (REQ-16.2)", () => {
    expect(checkPortable("notes:draft.md", true)).toMatchObject({
      reason: "forbidden-character",
      segment: "notes:draft.md",
    });
  });

  it.each(["CON", "con.md", "Aux.txt", "nul", "COM1.md", "lpt9", "COM¹"])(
    "rejects reserved name %s",
    (name) => {
      expect(checkPortable(`docs/${name}`, true)?.reason).toBe("reserved-name");
    },
  );

  it.each(["a<b", "a>b", 'a"b', "a|b", "a?b", "a*b", "a\\b", "a\u0007b"])("rejects %j", (name) => {
    expect(checkPortable(name, true)?.reason).toBe("forbidden-character");
  });

  it("describes a control character without printing it", () => {
    expect(checkPortable("a\u0007b", true)?.message).toContain("a control character");
  });

  it.each(["draft.", "draft ", "folder./a.md"])("rejects a trailing dot or space in %j", (name) => {
    expect(checkPortable(name, true)?.reason).toBe("trailing-dot-or-space");
  });

  it.each(["console.md", "COM10.md", "notes/draft.md", "café.md", ".hidden.md"])(
    "accepts %s",
    (name) => {
      expect(checkPortable(name, true)).toBeNull();
    },
  );
});

describe("checkPortable on a non-Windows target", () => {
  it("accepts names Windows would refuse", () => {
    expect(checkPortable("notes:draft.md", false)).toBeNull();
    expect(checkPortable("CON", false)).toBeNull();
    expect(checkPortable("draft.", false)).toBeNull();
  });

  it("still rejects NUL", () => {
    expect(checkPortable("a\u0000b", false)?.reason).toBe("nul");
    expect(checkPortable("a\u0000b", true)?.reason).toBe("nul");
  });
});
