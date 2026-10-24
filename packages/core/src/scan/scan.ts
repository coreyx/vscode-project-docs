/**
 * The scanner: walks one side into a snapshot of key -> content hash (design.md, `scan/`).
 *
 * A snapshot holds only what sync may act on. Files that must never sync in either direction are
 * left out silently; files that can't be synced safely are left out and reported, so the user
 * can see why a file isn't moving.
 */
import type { SideFs, Side } from "../sidefs/index.js";
import { isTempName } from "../sidefs/index.js";
import { decodeUtf8, detectLineEnding, markdownHash, sha256, type LineEnding } from "./content.js";
import type { IgnoreRules } from "./ignore.js";
import type { Scope } from "./scope.js";

/** Markdown files larger than this are skipped and reported (REQ-20.0.3). */
export const MAX_MARKDOWN_BYTES = 5 * 1024 * 1024;

/** Folders never scanned on either side: engine metadata, Obsidian's config and trash, git. */
const EXCLUDED_FOLDERS = new Set([".project-docs", ".obsidian", ".trash", ".git"]);

/** True for files that never sync in either direction, wherever they are (REQ-3.0.6). */
export function isNeverSynced(key: string): boolean {
  const name = key.slice(key.lastIndexOf("/") + 1);
  return (
    name === "PRIVATE.md" ||
    name === "PRIVATE.example.md" ||
    name.toLowerCase().endsWith(".private.md") ||
    // The link files, in case the docs folder is the repo root.
    name === ".project-docs.json" ||
    name === ".project-docs.local.json" ||
    isTempName(name)
  );
}

/** True for a folder key that the scanner never descends into. */
export function isExcludedFolder(key: string): boolean {
  return EXCLUDED_FOLDERS.has(key.slice(key.lastIndexOf("/") + 1));
}

/** True when a key names a Markdown file (`.md`, any case). */
export function isMarkdown(key: string): boolean {
  return key.toLowerCase().endsWith(".md");
}

/** One file the engine can sync. */
export interface SnapshotEntry {
  readonly key: string;
  readonly kind: "markdown" | "attachment";
  /** For Markdown, the hash of the LF-normalized text; for attachments, of the raw bytes. */
  readonly hash: string;
  readonly lineEnding: LineEnding;
  readonly size: number;
  readonly mtimeMs: number;
  /** True for the vault side's link note, which never syncs (REQ-2.0.3). */
  readonly isLinkNote: boolean;
}

/** A file the scanner left out, and why, for the Project Docs view. */
export interface SkippedFile {
  readonly key: string;
  readonly reason: "symlink" | "not-utf8" | "too-large";
  readonly message: string;
}

/** The result of scanning one side. */
export interface Snapshot {
  readonly side: Side;
  readonly entries: ReadonlyMap<string, SnapshotEntry>;
  readonly skipped: readonly SkippedFile[];
}

/** Hashes from earlier scans, keyed by key, reused when a file's size and time are unchanged. */
export type StatCache = Map<string, SnapshotEntry>;

/** Options for `scan`. */
export interface ScanOptions {
  /** Whether non-Markdown files are listed at all (attachment sync, REQ-11). */
  readonly includeAttachments: boolean;
  /** The link note's key on the vault side, if any. */
  readonly linkNoteKey?: string | undefined;
  /** Cache to reuse and update; omit to hash everything. */
  readonly cache?: StatCache | undefined;
  /**
   * The repo's ignore rules (design decision 20). Both sides get the same rules, so a file is left
   * out of both snapshots or neither. Omitted, nothing is ignored beyond the fixed exclusions.
   */
  readonly ignore?: IgnoreRules | undefined;
  /**
   * What the link syncs (design decision 21), applied to both sides by key. Omitted, everything
   * under the side's root is in scope.
   */
  readonly scope?: Scope | undefined;
}

/** Scans one side into a snapshot. */
export async function scan(fs: SideFs, options: ScanOptions): Promise<Snapshot> {
  const entries = new Map<string, SnapshotEntry>();
  const skipped: SkippedFile[] = [];
  const seen = new Set<string>();

  const { ignore, scope } = options;
  const skipFolder = (key: string) =>
    isExcludedFolder(key) || scope?.mayContain(key) === false || ignore?.skipsFolder(key) === true;
  for await (const file of fs.list(skipFolder)) {
    // Ignored and out-of-scope files are left out silently, like the never-synced names: they
    // aren't problems, and a vault note outside the scope simply stays in the vault (REQ-22.0.3).
    if (isNeverSynced(file.key) || scope?.includes(file.key) === false) continue;
    if (ignore?.skips(file.key, false)) continue;
    if (file.kind === "symlink") {
      skipped.push({
        key: file.key,
        reason: "symlink",
        message: `${file.key} is a symbolic link or junction, which Project Docs doesn't follow`,
      });
      continue;
    }
    const markdown = isMarkdown(file.key);
    if (!markdown && !options.includeAttachments) continue;
    if (markdown && file.size > MAX_MARKDOWN_BYTES) {
      skipped.push({
        key: file.key,
        reason: "too-large",
        message: `${file.key} is larger than 5 MB, so it isn't synced`,
      });
      continue;
    }
    seen.add(file.key);

    const cached = options.cache?.get(file.key);
    if (cached && cached.size === file.size && cached.mtimeMs === file.mtimeMs) {
      entries.set(file.key, { ...cached, isLinkNote: file.key === options.linkNoteKey });
      continue;
    }

    const bytes = await fs.read(file.key);
    let entry: SnapshotEntry;
    if (markdown) {
      const text = decodeUtf8(bytes);
      if (text === null) {
        skipped.push({
          key: file.key,
          reason: "not-utf8",
          message: `${file.key} isn't valid UTF-8, so it isn't synced`,
        });
        continue;
      }
      entry = {
        key: file.key,
        kind: "markdown",
        hash: markdownHash(text),
        lineEnding: detectLineEnding(text),
        size: file.size,
        mtimeMs: file.mtimeMs,
        isLinkNote: file.key === options.linkNoteKey,
      };
    } else {
      entry = {
        key: file.key,
        kind: "attachment",
        hash: sha256(bytes),
        lineEnding: "none",
        size: file.size,
        mtimeMs: file.mtimeMs,
        isLinkNote: false,
      };
    }
    entries.set(file.key, entry);
    options.cache?.set(file.key, entry);
  }

  // Forget files that are gone, so the cache can't grow without bound.
  if (options.cache) {
    for (const key of options.cache.keys()) if (!seen.has(key)) options.cache.delete(key);
  }
  return { side: fs.side, entries, skipped };
}
