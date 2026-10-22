/**
 * The filesystem interface the engine uses for each side of a link. The core never calls `fs`
 * directly for linked folders, so the CLI, the extension and fault-injecting tests can each supply
 * their own implementation (design.md, Interfaces).
 */

/** Which half of a link a path or operation belongs to. */
export type Side = "repo" | "vault";

/** One entry found while listing a side. Symbolic links and junctions are reported, never followed. */
export interface FileEntry {
  readonly key: string;
  readonly kind: "file" | "symlink";
  readonly size: number;
  readonly mtimeMs: number;
}

/** Moves the file at an absolute path somewhere the user can recover it from. */
export type TrashFn = (absolutePath: string) => Promise<void>;

/** Filesystem access for one side of a link, addressed by canonical keys. */
export interface SideFs {
  readonly side: Side;
  /** Absolute path of the linked folder. */
  readonly root: string;
  /** Whether names must satisfy Windows' rules here (REQ-16.0.2). */
  readonly isWindowsFs: boolean;
  /** Whether names differing only by case are the same file here (REQ-16.0.3). */
  readonly caseInsensitive: boolean;
  /** Lists every file below the root, skipping folders for which `skipFolder` returns true. */
  list(skipFolder?: (key: string) => boolean): AsyncIterable<FileEntry>;
  read(key: string): Promise<Uint8Array>;
  /** Writes so that a concurrent reader sees either the old or the new content, never a mix. */
  writeAtomic(key: string, data: Uint8Array): Promise<void>;
  /** Renames within the side; never overwrites another file. */
  rename(from: string, to: string): Promise<void>;
  /** Moves the file to this side's trash (REQ-6.0.3). */
  trash(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
}
