/**
 * Detects whether a folder lives on a case-insensitive filesystem, without writing anything into
 * the user's folders (TASK-3): it looks up the folder's own path with one letter's case swapped,
 * and compares file identities.
 */
import { stat } from "node:fs/promises";
import * as path from "node:path";

/** Swaps the case of the last cased letter in `segment`, or returns null if it has none. */
function swapOneLetter(segment: string): string | null {
  for (let i = segment.length - 1; i >= 0; i--) {
    const ch = segment[i] ?? "";
    const swapped = ch === ch.toLowerCase() ? ch.toUpperCase() : ch.toLowerCase();
    if (swapped !== ch) return segment.slice(0, i) + swapped + segment.slice(i + 1);
  }
  return null;
}

/**
 * Returns true when `folder` is on a case-insensitive filesystem. Walks up from `folder` to find a
 * path segment containing a letter, so a folder named `2026` still gets an answer from its parent.
 * Falls back to the platform's usual behavior if no segment has a letter.
 */
export async function probeCaseInsensitive(folder: string): Promise<boolean> {
  let current = path.resolve(folder);
  for (;;) {
    const parent = path.dirname(current);
    const name = path.basename(current);
    const swapped = swapOneLetter(name);
    if (swapped !== null) {
      const original = await stat(current);
      try {
        const other = await stat(path.join(parent, swapped));
        return other.ino === original.ino && other.dev === original.dev;
      } catch {
        return false;
      }
    }
    if (parent === current) return process.platform === "win32" || process.platform === "darwin";
    current = parent;
  }
}
