import { describe, expect, it } from "vitest";
import { offsetToPosition } from "../../src/privacy/positions.js";

describe("offsetToPosition", () => {
  it("counts lines and characters as VS Code does", () => {
    const text = "ab\ncd\r\nef";
    expect(offsetToPosition(text, 0)).toEqual({ line: 0, character: 0 });
    expect(offsetToPosition(text, 2)).toEqual({ line: 0, character: 2 });
    expect(offsetToPosition(text, 3)).toEqual({ line: 1, character: 0 });
    // In CRLF text the \r ends its own line.
    expect(offsetToPosition(text, 5)).toEqual({ line: 1, character: 2 });
    expect(offsetToPosition(text, 7)).toEqual({ line: 2, character: 0 });
    expect(offsetToPosition(text, 9)).toEqual({ line: 2, character: 2 });
  });
});
