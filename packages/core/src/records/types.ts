/**
 * The link records (REQ-2, design.md Data model): how a repo and its vault folder find each other.
 *
 * The record is split so a public repo never reveals anything about the machine: the committed
 * file holds only relative paths, a project id and settings; the gitignored machine-local file
 * holds the absolute vault path. Both describe themselves in plain words, for agents (REQ-2.0.5).
 */

/** Committed in the repo root. Contains no absolute path, user name or vault name (REQ-2.0.1). */
export const COMMITTED_FILE = ".project-docs.json";
/** Gitignored, in the repo root. The vault's location on this machine. */
export const LOCAL_FILE = ".project-docs.local.json";

/** Bumped only when a record's shape changes incompatibly. */
export const RECORD_FORMAT = 1;

export const COMMITTED_DESCRIPTION =
  "Project Docs link: this repo's docs folder is kept in sync with a folder in an Obsidian vault. The vault's location on this machine is in .project-docs.local.json.";
export const LOCAL_DESCRIPTION =
  "Project Docs: this machine's location of the linked vault folder. Not committed.";

/** Per-link settings, shared by everyone who clones the repo. */
export interface LinkSettingsRecord {
  readonly privateSubfolder: string;
  /** Where the link note goes: `{folder}` is the vault folder, `{folderName}` its last segment. */
  readonly folderNotePattern: string;
  readonly syncAttachments: boolean;
  readonly keepLinksAsWritten: boolean;
  readonly allowLinksOutsideProjectFolder: boolean;
  readonly advancedUriDeepLinks: boolean;
}

export const DEFAULT_SETTINGS: LinkSettingsRecord = {
  privateSubfolder: "private",
  folderNotePattern: "{folder}/{folderName}.md",
  syncAttachments: false,
  keepLinksAsWritten: false,
  allowLinksOutsideProjectFolder: false,
  advancedUriDeepLinks: false,
};

/** `.project-docs.json`. */
export interface CommittedLink {
  readonly format: number;
  readonly description: string;
  readonly projectId: string;
  /** The docs folder, relative to the repo root, with `/` separators. */
  readonly docsFolder: string;
  /** The vault folder, relative to the vault root. */
  readonly vaultFolder: string;
  readonly settings: LinkSettingsRecord;
  /** Present only while `advancedUriDeepLinks` is on (REQ-2.0.8). */
  readonly deepLink?: string | undefined;
}

/** `.project-docs.local.json`. */
export interface LocalLink {
  readonly format: number;
  readonly description: string;
  readonly projectId: string;
  /** Absolute path of the vault, as this side of the link opens it. */
  readonly vaultRoot: string;
  /** Absolute path of the linked vault folder. */
  readonly vaultFolderPath: string;
  /** Absolute path of the link note. */
  readonly linkNotePath: string;
}

/** What reading a repo's link records found. */
export type LinkState =
  | { readonly state: "unlinked" }
  | { readonly state: "linked"; readonly committed: CommittedLink; readonly local: LocalLink }
  /** Committed record without a matching local one: a fresh clone or another machine (REQ-2.0.7). */
  | { readonly state: "relink"; readonly committed: CommittedLink }
  | { readonly state: "invalid"; readonly file: string; readonly problems: readonly string[] };
