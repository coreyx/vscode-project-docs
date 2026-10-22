import { describe, expect, it } from "vitest";
import { CORE_VERSION } from "../src/index.js";

describe("core package", () => {
  it("exposes its version", () => {
    expect(CORE_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});
