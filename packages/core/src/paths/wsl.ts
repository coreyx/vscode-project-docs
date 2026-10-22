/**
 * WSL path translation (REQ-2.0.4, REQ-16.0.1).
 *
 * With the repo in WSL and the vault on Windows (or the other way round), each side has to record
 * the other's location in a form it can open: the Windows plugin needs `\\wsl.localhost\<distro>\…`
 * for a WSL repo, and the WSL extension needs `/mnt/<drive>/…` for a Windows vault. The mapping
 * is deterministic given the distro name and the automount root, so it's done here rather than by
 * shelling out to `wslpath`, which keeps it testable on any platform.
 */
import { readFileSync } from "node:fs";

/** What's needed to translate paths: the running distro and where Windows drives are mounted. */
export interface WslContext {
  readonly distro: string;
  /** Mount point of Windows drives, with a trailing slash; `/mnt/` unless wsl.conf says otherwise. */
  readonly automountRoot: string;
}

const DEFAULT_AUTOMOUNT_ROOT = "/mnt/";

/**
 * Reads `root` from the `[automount]` section of a wsl.conf, returning `/mnt/` when absent.
 * Takes the file's text so it can be tested; `detectWsl` passes the real file.
 */
export function parseAutomountRoot(wslConf: string | null): string {
  if (!wslConf) return DEFAULT_AUTOMOUNT_ROOT;
  let inAutomount = false;
  for (const raw of wslConf.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("[")) {
      inAutomount = line.toLowerCase() === "[automount]";
      continue;
    }
    const match = inAutomount ? /^root\s*=\s*(.+)$/i.exec(line) : null;
    if (match?.[1]) {
      const root = match[1].trim().replace(/^["']|["']$/g, "");
      return root.endsWith("/") ? root : `${root}/`;
    }
  }
  return DEFAULT_AUTOMOUNT_ROOT;
}

/**
 * Returns the WSL context when running inside WSL, otherwise null. WSL sets `WSL_DISTRO_NAME` in
 * every process it starts, which is the most reliable signal and also names the distro.
 */
export function detectWsl(
  env: NodeJS.ProcessEnv = process.env,
  readWslConf: () => string | null = readEtcWslConf,
): WslContext | null {
  const distro = env["WSL_DISTRO_NAME"];
  if (!distro) return null;
  return { distro, automountRoot: parseAutomountRoot(readWslConf()) };
}

function readEtcWslConf(): string | null {
  try {
    return readFileSync("/etc/wsl.conf", "utf8");
  } catch {
    return null;
  }
}

/** Returns the drive letter when `wslPath` is on a mounted Windows drive, otherwise null. */
export function windowsDriveOf(wslPath: string, ctx: WslContext): string | null {
  if (!wslPath.startsWith(ctx.automountRoot)) return null;
  const match = /^([a-z])(?:\/|$)/i.exec(wslPath.slice(ctx.automountRoot.length));
  return match?.[1] ? match[1].toUpperCase() : null;
}

/**
 * Translates a path as seen inside WSL into the form Windows programs open: a drive path for
 * mounted drives, or a `\\wsl.localhost\<distro>\…` UNC path for the WSL filesystem.
 */
export function wslToWindows(wslPath: string, ctx: WslContext): string {
  const drive = windowsDriveOf(wslPath, ctx);
  if (drive) {
    const rest = wslPath.slice(ctx.automountRoot.length + 1).replace(/^\//, "");
    return `${drive}:\\${rest.replace(/\//g, "\\")}`;
  }
  return `\\\\wsl.localhost\\${ctx.distro}${wslPath.replace(/\//g, "\\")}`;
}

/**
 * Translates a Windows path into the form a process inside WSL opens. Accepts drive paths and
 * both UNC spellings of the WSL filesystem (`\\wsl.localhost\…` and the older `\\wsl$\…`).
 * Returns null for anything WSL can't reach, such as a network share.
 */
export function windowsToWsl(
  windowsPath: string,
  ctx: Pick<WslContext, "automountRoot">,
): string | null {
  const unified = windowsPath.replace(/\\/g, "/");
  const drive = /^([A-Za-z]):(\/.*)?$/.exec(unified);
  if (drive?.[1]) {
    return `${ctx.automountRoot}${drive[1].toLowerCase()}${drive[2] ?? ""}`;
  }
  const unc = /^\/\/(?:wsl\.localhost|wsl\$)\/[^/]+(\/.*)?$/i.exec(unified);
  if (unc) return unc[1] ?? "/";
  return null;
}

/**
 * Whether a path lives on a Windows filesystem, which decides the portability rules and default
 * line endings for that side: true on Windows itself, and for a mounted drive seen from WSL.
 */
export function isWindowsFs(
  absolutePath: string,
  platform: NodeJS.Platform = process.platform,
  wsl: WslContext | null = detectWsl(),
): boolean {
  if (platform === "win32") return true;
  return wsl !== null && windowsDriveOf(absolutePath, wsl) !== null;
}
