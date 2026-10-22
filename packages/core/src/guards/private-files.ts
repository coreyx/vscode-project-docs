/**
 * The private-files list (REQ-11.0.3): attachments recorded by the Obsidian plugin as private,
 * by path and content hash, kept in `<vault folder>/.project-docs/private-files.json`.
 *
 * The engine only reads it, and reads it defensively: a list it can't understand protects every
 * attachment rather than none (TASK-11).
 */

/** One recorded private file. `path` is its key within the project folder. */
export interface PrivateFileRecord {
  readonly path: string;
  readonly sha256: string;
}

/** The parsed list. */
export interface PrivateFilesList {
  readonly paths: ReadonlySet<string>;
  readonly hashes: ReadonlySet<string>;
}

/** A list that couldn't be read; every attachment is then held back. */
export const INVALID_PRIVATE_FILES = "invalid" as const;

export const EMPTY_PRIVATE_FILES: PrivateFilesList = { paths: new Set(), hashes: new Set() };

/** Parses the file's text; `null` text means the file doesn't exist, which is an empty list. */
export function parsePrivateFilesList(
  text: string | null,
): PrivateFilesList | typeof INVALID_PRIVATE_FILES {
  if (text === null) return EMPTY_PRIVATE_FILES;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return INVALID_PRIVATE_FILES;
  }
  const files = (value as { files?: unknown } | null)?.files;
  if (!Array.isArray(files)) return INVALID_PRIVATE_FILES;
  const paths = new Set<string>();
  const hashes = new Set<string>();
  for (const record of files as unknown[]) {
    const { path, sha256 } = (record ?? {}) as Partial<PrivateFileRecord>;
    if (typeof path !== "string" || typeof sha256 !== "string") return INVALID_PRIVATE_FILES;
    paths.add(path);
    hashes.add(sha256);
  }
  return { paths, hashes };
}
