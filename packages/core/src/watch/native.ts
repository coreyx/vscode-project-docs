/**
 * Native recursive watching with Node's `fs.watch`, for folders VS Code's own watcher doesn't
 * reliably report, such as a vault outside the workspace. Events for the engine's own metadata and
 * temporary files are dropped, so the engine's writes can't set off a pass loop.
 */
import { watch, type FSWatcher } from "node:fs";

/** True for paths that never need a sync pass: engine metadata, Obsidian config and trash, temp files. */
export function isIgnoredChange(relativePath: string): boolean {
  const parts = relativePath.replace(/\\/g, "/").split("/");
  return (
    parts.some(
      (part) =>
        part === ".project-docs" || part === ".obsidian" || part === ".trash" || part === ".git",
    ) || parts.some((part) => part.includes(".pd-tmp-"))
  );
}

/**
 * Watches `root` recursively and calls `onChange` for relevant changes. Returns a function that
 * stops watching, or null when recursive watching isn't available here, so the caller can poll.
 */
export function startNativeWatch(
  root: string,
  onChange: () => void,
  onError?: (error: unknown) => void,
): (() => void) | null {
  let watcher: FSWatcher;
  try {
    watcher = watch(root, { recursive: true }, (_event, filename) => {
      // Some platforms don't say which file changed; treat that as relevant.
      if (filename === null || !isIgnoredChange(filename.toString())) onChange();
    });
  } catch {
    return null;
  }
  watcher.on("error", (error) => onError?.(error));
  return () => watcher.close();
}
