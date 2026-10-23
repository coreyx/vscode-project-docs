import { describe, expect, it } from "vitest";
import { parsePlaceholders } from "@specdevship/project-docs-core";
import {
  STANDARD_URL,
  privateExampleTemplate,
  privateMdTemplate,
} from "../../src/privatemd/templates.js";

describe("the PRIVATE.md templates (REQ-15.0.3)", () => {
  it("starts PRIVATE.md with an empty placeholder table", () => {
    const text = privateMdTemplate("\n");
    expect(text).toContain(
      "## Placeholders\n\n| Placeholder in the repo | Real value | What it is |",
    );
    // No rows yet: a valid, empty table under the standard's 0.2.0 (design decision 19), in both
    // line-ending styles.
    expect(parsePlaceholders(text).size).toBe(0);
    expect(parsePlaceholders(privateMdTemplate("\r\n")).size).toBe(0);
    expect(text).toContain(STANDARD_URL);
  });

  it("gives PRIVATE.example.md the same structure with a fake row", () => {
    const text = privateExampleTemplate("\r\n");
    expect([...parsePlaceholders(text)]).toEqual([["myhost", "DESK-FAKE01"]]);
    expect(text.split("\r\n").length).toBeGreaterThan(5);
    expect(text.replace(/\r\n/g, "")).not.toContain("\n");
  });
});
