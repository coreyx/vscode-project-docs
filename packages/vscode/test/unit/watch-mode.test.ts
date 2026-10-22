import { describe, expect, it } from "vitest";
import { needsPolling } from "../../src/sync/watch-mode.js";

const wsl = { distro: "Ubuntu", automountRoot: "/mnt/" };

describe("needsPolling (REQ-4.0.2)", () => {
  it("polls a Windows drive seen from WSL", () => {
    expect(needsPolling("/mnt/c/Users/me/Vault", wsl, "linux")).toBe(true);
    expect(needsPolling("/home/me/vault", wsl, "linux")).toBe(false);
  });

  it("polls a network share on Windows, but not a long-path prefix", () => {
    expect(needsPolling("\\\\server\\share\\Vault", null, "win32")).toBe(true);
    expect(needsPolling("\\\\?\\C:\\Vault", null, "win32")).toBe(false);
    expect(needsPolling("C:\\Users\\me\\Vault", null, "win32")).toBe(false);
  });

  it("uses native watching on an ordinary local disk", () => {
    expect(needsPolling("/Users/me/Vault", null, "darwin")).toBe(false);
    expect(needsPolling("/home/me/vault", null, "linux")).toBe(false);
  });
});
