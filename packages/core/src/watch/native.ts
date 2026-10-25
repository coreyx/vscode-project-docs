/**
 * Native recursive watching with Node's `fs.watch`, for folders VS Code's own watcher doesn't
 * reliably report, such as a vault outside the workspace. Events for the engine's own metadata and
 * temporary files are dropped, so the engine's writes can't set off a pass loop.
 */
import { realpathSync, watch, type FSWatcher } from "node:fs";

/**
 * True for paths that never need a sync pass: engine metadata, Obsidian config and trash, temp
 * files, and `node_modules`, which never syncs (REQ-3.0.7), so an install doesn't start passes.
 */
export function isIgnoredChange(relativePath: string): boolean {
  const parts = relativePath.replace(/\\/g, "/").split("/");
  return (
    parts.some(
      (part) =>
        part === ".project-docs" ||
        part === ".obsidian" ||
        part === ".trash" ||
        part === ".git" ||
        part === "node_modules",
    ) || parts.some((part) => part.includes(".pd-tmp-"))
  );
}

/**
 * Files in the vault folder's metadata that the Obsidian plugin writes for the engine to act on.
 * The rest of `.project-docs` never needs a pass, but a change to one of these does: without it,
 * a choice made in Obsidian, such as Keep syncing it, waits for the next rescan. The engine only
 * reads them, so watching them can't set off a pass loop.
 */
export const ENGINE_INPUTS: readonly string[] = [".project-docs/ignored-choices.json"];

/** True for a path, relative to the vault folder, that is one of the `ENGINE_INPUTS`. */
export function isEngineInput(relativePath: string): boolean {
  return ENGINE_INPUTS.includes(relativePath.replace(/\\/g, "/"));
}

/**
 * Watches `root` recursively and calls `onChange` for relevant changes: the `ENGINE_INPUTS`, and
 * others that `isIgnoredChange` keeps and `relevant` accepts, such as those in the link's scope
 * (design decision 21). Returns a function that stops watching, or null when recursive watching
 * isn't available here, so the caller can poll.
 */
export function startNativeWatch(
  root: string,
  onChange: () => void,
  onError?: (error: unknown) => void,
  relevant: (relativePath: string) => boolean = () => true,
): (() => void) | null {
  let watcher: FSWatcher;
  // Watched by its real path: given a Windows 8.3 short name (C:\Users\RUNNER~1\...), recursive
  // watching reports names relative to the long form but cut by the short form's length, such as
  // "ult\Projects\..." for "Vault\Projects\...", which the scope check would then drop.
  let target = root;
  try {
    target = realpathSync.native(root);
  } catch {
    // Watch it as given; a missing folder fails just below.
  }
  try {
    watcher = watch(target, { recursive: true }, (_event, filename) => {
      // Some platforms don't say which file changed; treat that as relevant.
      if (filename === null) onChange();
      else if (isEngineInput(filename.toString())) onChange();
      else if (!isIgnoredChange(filename.toString()) && relevant(filename.toString())) onChange();
    });
  } catch {
    return null;
  }
  watcher.on("error", (error) => onError?.(error));
  return () => watcher.close();
}
