/**
 * Canonical keys: how every file is identified across the two sides of a link.
 *
 * A key is the file's path relative to its linked folder, with `/` separators and Unicode NFC.
 * The same file has the same key on both sides (no path remapping, design decision 2), so keys
 * must not depend on the platform's separator or on how the filesystem normalizes Unicode (macOS
 * hands back NFD names, Windows and Linux keep whatever was written).
 */
import * as path from "node:path";

/** Thrown when a path can't be a key: absolute, escaping the folder, or empty. */
export class InvalidKeyError extends Error {
  constructor(
    readonly input: string,
    reason: string,
  ) {
    super(`${JSON.stringify(input)} is not a valid relative path: ${reason}`);
    this.name = "InvalidKeyError";
  }
}

/**
 * Turns a relative path, written with either separator, into a canonical key.
 * Rejects absolute paths and `..` segments, since a key must stay inside its linked folder.
 */
export function toKey(relativePath: string): string {
  const unified = relativePath.normalize("NFC").replace(/\\/g, "/");
  if (unified.startsWith("/") || /^[A-Za-z]:/.test(unified)) {
    throw new InvalidKeyError(relativePath, "absolute");
  }
  const segments = unified.split("/").filter((s) => s !== "" && s !== ".");
  if (segments.includes("..")) throw new InvalidKeyError(relativePath, "leaves the linked folder");
  if (segments.length === 0) throw new InvalidKeyError(relativePath, "empty");
  return segments.join("/");
}

/** Returns the key of `absolutePath` within the linked folder `root`. */
export function keyFromAbsolute(root: string, absolutePath: string): string {
  return toKey(path.relative(root, absolutePath));
}

/** Returns the absolute path of `key` within `root`, using the platform's separator. */
export function absoluteFromKey(root: string, key: string): string {
  return path.join(root, ...key.split("/"));
}

/**
 * The case-folded form of a key, used to find files that one side would treat as the same name.
 * Lower-casing after NFC matches how Windows and macOS compare names closely enough for clash
 * detection; an exotic mismatch only means a clash is reported that the filesystem might allow.
 */
export function foldKey(key: string): string {
  return key.normalize("NFC").toLowerCase();
}

/**
 * Groups keys that differ only by case. Each returned group has two or more keys, sorted, and
 * groups are sorted by their first key so results are deterministic.
 */
export function findCaseClashes(keys: Iterable<string>): string[][] {
  const byFold = new Map<string, Set<string>>();
  for (const key of keys) {
    const folded = foldKey(key);
    const group = byFold.get(folded) ?? new Set<string>();
    group.add(key);
    byFold.set(folded, group);
  }
  return [...byFold.values()]
    .filter((group) => group.size > 1)
    .map((group) => [...group].sort())
    .sort((a, b) => compareCodeUnits(a[0] ?? "", b[0] ?? ""));
}

/** Orders strings by UTF-16 code units, so results don't vary with the machine's locale. */
function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** True when two keys name the same file on a case-insensitive filesystem but differ in case. */
export function isCaseOnlyChange(from: string, to: string): boolean {
  return from !== to && foldKey(from) === foldKey(to);
}
