/**
 * Finding the vaults Obsidian knows about, so linking can offer them (REQ-1.0.1). Obsidian keeps
 * them in `obsidian.json` in its config folder, whose location depends on the platform and on how
 * Obsidian was installed. From WSL, the Windows config is read through the mounted drive and its
 * paths are translated into the form WSL opens.
 */
import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";
import { windowsToWsl, type WslContext } from "@specdevship/project-docs-core";

/** A vault from Obsidian's registry. */
export interface KnownVault {
  /** The vault's folder name, which is what Obsidian shows. */
  readonly name: string;
  /** Absolute path, in the form this process opens. */
  readonly path: string;
  /** When Obsidian last opened it, for ordering. */
  readonly lastOpened: number;
}

/** Where Obsidian keeps `obsidian.json` on this platform, most likely first. */
export function registryCandidates(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string[] {
  if (platform === "win32") {
    const appData = env["APPDATA"] ?? path.win32.join(home, "AppData", "Roaming");
    return [path.win32.join(appData, "obsidian", "obsidian.json")];
  }
  if (platform === "darwin") {
    return [path.posix.join(home, "Library", "Application Support", "obsidian", "obsidian.json")];
  }
  const config = env["XDG_CONFIG_HOME"] ?? path.posix.join(home, ".config");
  return [
    path.posix.join(config, "obsidian", "obsidian.json"),
    // Flatpak and Snap keep their own config folders.
    path.posix.join(
      home,
      ".var",
      "app",
      "md.obsidian.Obsidian",
      "config",
      "obsidian",
      "obsidian.json",
    ),
    path.posix.join(home, "snap", "obsidian", "current", ".config", "obsidian", "obsidian.json"),
  ];
}

/** Under WSL, the Windows users' Obsidian registries on the mounted C: drive. */
export async function wslRegistryCandidates(wsl: WslContext): Promise<string[]> {
  const users = path.posix.join(wsl.automountRoot, "c", "Users");
  let names: string[];
  try {
    names = await readdir(users);
  } catch {
    return [];
  }
  return names.map((name) =>
    path.posix.join(users, name, "AppData", "Roaming", "obsidian", "obsidian.json"),
  );
}

/** Parses `obsidian.json`, translating Windows paths when reading it from WSL. */
export function parseRegistry(
  text: string,
  wsl: WslContext | null,
  fromWindows: boolean,
): KnownVault[] {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return [];
  }
  const vaults = (value as { vaults?: Record<string, { path?: unknown; ts?: unknown }> } | null)
    ?.vaults;
  if (!vaults || typeof vaults !== "object") return [];
  const result: KnownVault[] = [];
  for (const entry of Object.values(vaults)) {
    if (typeof entry?.path !== "string") continue;
    const located = wsl && fromWindows ? windowsToWsl(entry.path, wsl) : entry.path;
    if (!located) continue;
    result.push({
      name: located.split(/[\\/]/).filter(Boolean).pop() ?? located,
      path: located,
      lastOpened: typeof entry.ts === "number" ? entry.ts : 0,
    });
  }
  return result;
}

/** Every vault Obsidian knows about on this machine, most recently opened first. */
export async function knownVaults(wsl: WslContext | null): Promise<KnownVault[]> {
  const sources: { file: string; fromWindows: boolean }[] = registryCandidates().map((file) => ({
    file,
    fromWindows: false,
  }));
  if (wsl) {
    for (const file of await wslRegistryCandidates(wsl)) sources.push({ file, fromWindows: true });
  }
  const seen = new Set<string>();
  const vaults: KnownVault[] = [];
  for (const { file, fromWindows } of sources) {
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch {
      continue;
    }
    for (const vault of parseRegistry(text, wsl, fromWindows)) {
      if (seen.has(vault.path)) continue;
      seen.add(vault.path);
      vaults.push(vault);
    }
  }
  return vaults.sort((a, b) => b.lastOpened - a.lastOpened);
}
