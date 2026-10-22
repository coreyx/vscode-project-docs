/**
 * Choosing how to watch a folder (REQ-4.0.2): VS Code's native watcher where it's reliable, polling
 * where it isn't.
 */
import { windowsDriveOf, type WslContext } from "@specdevship/project-docs-core";

/**
 * True when native watching can't be trusted for `folder`: a Windows drive seen from WSL (file
 * events from Windows programs such as Obsidian don't reach Linux watchers across that boundary),
 * or a network share.
 */
export function needsPolling(
  folder: string,
  wsl: WslContext | null,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (wsl && windowsDriveOf(folder, wsl) !== null) return true;
  if (platform === "win32" && /^\\\\(?!\?\\)/.test(folder)) return true;
  return false;
}
