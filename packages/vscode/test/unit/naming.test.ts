import { describe, expect, it } from "vitest";
import { DECODED_SCHEME, DECODED_SUFFIX, decodedUriParts } from "../../src/decoded/naming.js";

describe("decodedUriParts (REQ-14.0.4)", () => {
  it("names the tab with the decoded suffix and carries the source in the query", () => {
    const parts = decodedUriParts("/r/docs/a.md", "file:///r/docs/a.md");
    expect(parts).toEqual({
      scheme: DECODED_SCHEME,
      path: "/r/docs/a.md (Decoded: real values shown)",
      query: "file:///r/docs/a.md",
    });
    expect(parts.path.endsWith(DECODED_SUFFIX)).toBe(true);
  });
});
