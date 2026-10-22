import { describe, expect, it } from "vitest";
import {
  detectWsl,
  isWindowsFs,
  parseAutomountRoot,
  windowsDriveOf,
  windowsToWsl,
  wslToWindows,
  type WslContext,
} from "../../src/paths/index.js";

const ctx: WslContext = { distro: "Ubuntu", automountRoot: "/mnt/" };

describe("parseAutomountRoot", () => {
  it("defaults to /mnt/", () => {
    expect(parseAutomountRoot(null)).toBe("/mnt/");
    expect(parseAutomountRoot("[network]\nhostname=x\n")).toBe("/mnt/");
  });

  it("reads root from the [automount] section only, with CRLF and quotes", () => {
    const conf =
      "[network]\nroot = /nope\n[automount]\r\nenabled=true\r\nroot = \u0022/win\u0022\r\n";
    expect(parseAutomountRoot(conf)).toBe("/win/");
  });
});

describe("detectWsl", () => {
  it("is null outside WSL", () => {
    expect(detectWsl({}, () => null)).toBeNull();
  });

  it("reads the distro and automount root inside WSL", () => {
    expect(detectWsl({ WSL_DISTRO_NAME: "Debian" }, () => "[automount]\nroot=/w/")).toEqual({
      distro: "Debian",
      automountRoot: "/w/",
    });
  });
});

describe("translation", () => {
  it.each([
    ["/mnt/c/Users/me/Vault", "C:\\Users\\me\\Vault"],
    ["/mnt/d", "D:\\"],
    ["/home/me/src/repo", "\\\\wsl.localhost\\Ubuntu\\home\\me\\src\\repo"],
    ["/mnt/cdrom/x", "\\\\wsl.localhost\\Ubuntu\\mnt\\cdrom\\x"],
  ])("WSL %s is Windows %s", (wsl, windows) => {
    expect(wslToWindows(wsl, ctx)).toBe(windows);
  });

  it.each([
    ["C:\\Users\\me\\Vault", "/mnt/c/Users/me/Vault"],
    ["d:", "/mnt/d"],
    ["\\\\wsl.localhost\\Ubuntu\\home\\me\\src\\repo", "/home/me/src/repo"],
    ["\\\\wsl$\\Ubuntu\\home\\me", "/home/me"],
    ["\\\\wsl.localhost\\Ubuntu", "/"],
  ])("Windows %s is WSL %s", (windows, wsl) => {
    expect(windowsToWsl(windows, ctx)).toBe(wsl);
  });

  it("can't reach a network share from WSL", () => {
    expect(windowsToWsl("\\\\server\\share\\docs", ctx)).toBeNull();
  });

  it("respects a custom automount root", () => {
    const custom = { distro: "Ubuntu", automountRoot: "/win/" };
    expect(wslToWindows("/win/c/x", custom)).toBe("C:\\x");
    expect(windowsToWsl("C:\\x", custom)).toBe("/win/c/x");
  });
});

describe("isWindowsFs", () => {
  it("is true on Windows", () => {
    expect(isWindowsFs("C:\\Vault", "win32", null)).toBe(true);
  });

  it("is true for a Windows drive seen from WSL, false for the WSL filesystem", () => {
    expect(windowsDriveOf("/mnt/c/Vault", ctx)).toBe("C");
    expect(isWindowsFs("/mnt/c/Vault", "linux", ctx)).toBe(true);
    expect(isWindowsFs("/home/me/repo", "linux", ctx)).toBe(false);
  });

  it("is false on Linux and macOS outside WSL", () => {
    expect(isWindowsFs("/mnt/c/Vault", "linux", null)).toBe(false);
    expect(isWindowsFs("/Users/me/Vault", "darwin", null)).toBe(false);
  });
});
