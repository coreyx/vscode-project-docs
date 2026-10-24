/**
 * The planner's inputs and outputs (design.md, Interfaces). A plan is a complete, ordered
 * description of everything one sync pass will do, computed without touching either folder.
 */
import type { IgnoreRules, Scope } from "../scan/index.js";
import type { PrivateFilesList, INVALID_PRIVATE_FILES } from "../guards/index.js";
import type { LinkResolver } from "../links/index.js";
import type { PrivateMdMapping } from "../privatemd/index.js";
import type { LineEnding, Snapshot } from "../scan/index.js";
import type { Side } from "../sidefs/index.js";
import type { Index, IndexEntry } from "../state/index.js";
import type { Confirmation } from "../status/index.js";

/** Per-link settings that change what the planner does (the committed link file's `settings`). */
export interface LinkSettings {
  readonly privateSubfolder: string;
  readonly syncAttachments: boolean;
  readonly keepLinksAsWritten: boolean;
  readonly allowLinksOutsideProjectFolder: boolean;
}

/** What one side's filesystem is like, for portability and case checks. */
export interface SideTraits {
  readonly isWindowsFs: boolean;
  readonly caseInsensitive: boolean;
}

/** Everything `plan` reads. */
export interface PlanInput {
  readonly repo: Snapshot;
  readonly vault: Snapshot;
  readonly index: Index;
  readonly settings: LinkSettings;
  readonly repoTraits: SideTraits;
  readonly vaultTraits: SideTraits;
  readonly linkNoteKey?: string | undefined;
  readonly privateFiles: PrivateFilesList | typeof INVALID_PRIVATE_FILES;
  /** Notes the user agreed in Obsidian may leave privacy, by path and hash (design decision 17). */
  readonly confirmations?: readonly Confirmation[];
  /**
   * The repo's ignore rules, which also built the snapshots (design decision 20). An index entry
   * whose key they now skip is set aside as `ignored` instead of being planned as a deletion.
   */
  readonly ignore?: IgnoreRules | undefined;
  /**
   * What the link syncs, which also built the snapshots (design decision 21). An index entry out
   * of scope is forgotten before rename detection, deleting nothing.
   */
  readonly scope?: Scope | undefined;
  readonly mapping: PrivateMdMapping | null;
  readonly resolver: LinkResolver;
  /** Reads a Markdown file's text from a side; null if it vanished since the scan. */
  readonly readText: (side: Side, key: string) => Promise<string | null>;
  /** Reads a base's LF text from the blob store; null if it's missing. */
  readonly readBase: (hash: string) => Promise<string | null>;
}

/** Writes the result of an action into the index. `entry: null` removes the key. */
export interface IndexUpdate {
  readonly key: string;
  readonly entry: IndexEntry | null;
}

/** Something the user should know or act on, shown in the Project Docs view. */
export interface Notice {
  readonly key: string;
  readonly code:
    | "conflict"
    | "held-back"
    | "delete-overridden"
    | "no-longer-synced"
    | "repo-only-vault-copy"
    | "repo-to-vault-edit"
    | "unconvertible-links"
    | "invalid-rule"
    | "case-clash"
    | "not-portable"
    | "scan-skipped"
    | "was-private"
    | "ignore-rules-unreadable"
    | "now-ignored";
  /** Contains no real value. */
  readonly message: string;
  readonly reasons?: readonly string[];
  /**
   * A fix the system can apply for the user: replacing real values with their placeholders;
   * once the user confirms, syncing a note that was private; or, for synced notes that became
   * ignored, keeping them synced (`sync-ignored`, with stopping also offered) or, where they can't
   * be kept, as in `node_modules`, only stopping (`stop-syncing`).
   */
  readonly fix?: "replace-real-values" | "confirm-syncable" | "sync-ignored" | "stop-syncing";
}

/** One step of a pass. Every action says how the index changes once it has been carried out. */
export type Action =
  | {
      /** Copy a file's current content from one side to the other. */
      readonly type: "copy";
      readonly key: string;
      readonly from: Side;
      readonly kind: "markdown" | "attachment";
      /** The source content's hash, checked again before writing. */
      readonly hash: string;
      readonly targetLineEnding: LineEnding;
      /** Whether this replaces an existing, different file on the target side. */
      readonly overwrites: boolean;
      /**
       * The target's hash when planned (null: no file). If the target has changed since, the copy
       * is skipped rather than overwriting an edit the planner never saw.
       */
      readonly expectTargetHash: string | null;
      readonly update: IndexUpdate;
    }
  | {
      /** Write the same Markdown to both sides: a merge result or a wikilink conversion. */
      readonly type: "writeBoth";
      readonly key: string;
      /** LF text. */
      readonly text: string;
      readonly hash: string;
      readonly repoLineEnding: LineEnding;
      readonly vaultLineEnding: LineEnding;
      /** The hashes each side must still have for the write to go ahead. */
      readonly expectRepoHash: string | null;
      readonly expectVaultHash: string | null;
      readonly overwrites: boolean;
      readonly update: IndexUpdate;
    }
  | {
      readonly type: "rename";
      readonly side: Side;
      readonly from: string;
      readonly to: string;
      readonly update: IndexUpdate;
      /** The old key's index entry is removed. */
      readonly removeKey: string;
    }
  | {
      /** Move a file to its side's trash (REQ-6.0.3). */
      readonly type: "trash";
      readonly side: Side;
      readonly key: string;
      readonly hash: string;
      readonly update: IndexUpdate;
    }
  | {
      /**
       * Overlapping changes (REQ-5.0.3): keep the repo's version on both sides and save the
       * vault's version in the conflict store.
       */
      readonly type: "conflict";
      readonly key: string;
      readonly kind: "markdown" | "attachment";
      readonly repoHash: string;
      readonly vaultHash: string;
      readonly baseHash: string | null;
      readonly vaultLineEnding: LineEnding;
      readonly update: IndexUpdate;
    }
  | {
      /** Record agreement without writing anything. */
      readonly type: "adopt";
      readonly key: string;
      readonly update: IndexUpdate;
    }
  | {
      /** Change only the index: hold back, skip, mark vault-only, or forget a key. */
      readonly type: "record";
      readonly key: string;
      readonly update: IndexUpdate;
    };

/** The bulk guard's verdict on a plan (REQ-7, design decision 12). */
export interface BulkCheck {
  readonly destructive: number;
  readonly threshold: number;
  readonly guarded: boolean;
}

/** The result of planning one pass. */
export interface Plan {
  readonly actions: readonly Action[];
  readonly notices: readonly Notice[];
  readonly bulk: BulkCheck;
}
