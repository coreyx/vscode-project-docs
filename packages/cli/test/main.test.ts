import { afterEach, describe, expect, it, vi } from "vitest";
import { CORE_VERSION } from "@specdevship/project-docs-core";
import { main } from "../src/main.js";

describe("project-docs command", () => {
  afterEach(() => vi.restoreAllMocks());

  it("prints the version", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(main(["--version"])).toBe(0);
    expect(log).toHaveBeenCalledWith(CORE_VERSION);
  });

  it("prints usage with no arguments or --help", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(main([])).toBe(0);
    expect(main(["--help"])).toBe(0);
    expect(log.mock.calls.every(([text]) => String(text).startsWith("Usage: project-docs"))).toBe(
      true,
    );
  });

  it("rejects an unknown command", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(main(["frobnicate"])).toBe(1);
    expect(String(error.mock.calls[0]?.[0])).toContain("Unknown command: frobnicate");
  });
});
