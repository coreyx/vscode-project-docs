/**
 * The vault metadata the engine and the Obsidian plugin share (design decision 7): `status.json`,
 * which the engine writes and the plugin reads, and `private-files.json`, which the plugin writes
 * and the engine reads. Both live in `<vault folder>/.project-docs/`, the one place both can reach
 * under WSL, and the scanner never syncs that folder.
 */
import * as path from "node:path";
import type { PrivateFileRecord } from "../guards/index.js";

/** Name of the hidden folder inside the vault folder that holds the shared metadata. */
export const METADATA_FOLDER = ".project-docs";

/** Format version of `status.json`; bumped only when its shape changes incompatibly. */
export const STATUS_FORMAT = 1;

/** Format version of `private-files.json`. */
export const PRIVATE_FILES_FORMAT = 1;

/** Where the status file lives for a vault folder. */
export function statusFilePath(vaultFolderPath: string): string {
  return path.join(vaultFolderPath, METADATA_FOLDER, "status.json");
}

/** Where the private-files list lives for a vault folder. */
export function privateFilesPath(vaultFolderPath: string): string {
  return path.join(vaultFolderPath, METADATA_FOLDER, "private-files.json");
}

/**
 * One problem the engine reports for a file: a notice from the last pass, or a write that keeps
 * failing. Contains no real values.
 */
export interface StatusItem {
  /** A notice code, such as `conflict` or `held-back`, or `write-failing`. */
  readonly kind: string;
  /** The file's key within the project folder. */
  readonly path: string;
  readonly message: string;
  readonly reasons: readonly string[];
  /** A fix the engine can apply for the user, such as `replace-real-values`. */
  readonly fix?: string;
}

/** The parsed `status.json`. */
export interface StatusFile {
  readonly format: number;
  readonly updatedAt: string;
  /** `attention` when there are items to show; the engine writes `idle` otherwise. */
  readonly state: "idle" | "syncing" | "paused" | "attention";
  readonly items: readonly StatusItem[];
}

const STATES: readonly StatusFile["state"][] = ["idle", "syncing", "paused", "attention"];

function isStatusItem(value: unknown): value is StatusItem {
  const item = value as Partial<StatusItem> | null;
  return (
    typeof item?.kind === "string" &&
    typeof item.path === "string" &&
    typeof item.message === "string" &&
    Array.isArray(item.reasons) &&
    item.reasons.every((r) => typeof r === "string") &&
    (item.fix === undefined || typeof item.fix === "string")
  );
}

/**
 * Parses the status file's text. Returns `null` for a missing, unreadable or newer-format file:
 * a reader then shows no problems rather than guessing at a shape it doesn't know.
 */
export function parseStatusFile(text: string | null): StatusFile | null {
  if (text === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  const file = value as Partial<StatusFile> | null;
  if (file?.format !== STATUS_FORMAT) return null;
  if (typeof file.updatedAt !== "string") return null;
  if (!STATES.includes(file.state as StatusFile["state"])) return null;
  if (!Array.isArray(file.items) || !file.items.every(isStatusItem)) return null;
  return {
    format: file.format,
    updatedAt: file.updatedAt,
    state: file.state as StatusFile["state"],
    items: file.items,
  };
}

/** Serializes a status file, as the engine writes it. */
export function serializeStatusFile(status: Omit<StatusFile, "format">): string {
  return `${JSON.stringify({ format: STATUS_FORMAT, ...status }, null, 2)}\n`;
}

/**
 * Serializes the private-files list, as the plugin writes it. Records are sorted by path so the
 * file doesn't churn when the plugin re-records the same set in a different order.
 */
export function serializePrivateFilesList(files: readonly PrivateFileRecord[]): string {
  const sorted = [...files]
    .map(({ path: p, sha256 }) => ({ path: p, sha256 }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return `${JSON.stringify({ format: PRIVATE_FILES_FORMAT, files: sorted }, null, 2)}\n`;
}
