/**
 * The privacy guards (REQ-10, REQ-11, REQ-13, design decision 5): every change on its way from
 * the vault to the repo passes through `checkVaultChange` before the planner may write it.
 *
 * A change is either allowed, vault-only (a private file that simply never syncs, which isn't a
 * problem to report), or held back (a synced file whose new content would expose something private,
 * which the user is told about). Reasons name placeholders and link text, never real values.
 */
import { linkTargets, type LinkResolver, type ResolvedLink } from "../links/index.js";
import { findRealValueRanges, findRealValues, type PrivateMdMapping } from "../privatemd/index.js";
import { readRule } from "../rules/index.js";
import { isNeverSynced } from "../scan/index.js";
import { INVALID_PRIVATE_FILES, type PrivateFilesList } from "./private-files.js";

/** Why a change is vault-only or held back. */
export interface GuardReason {
  readonly code:
    | "never-synced"
    | "link-note"
    | "private-folder"
    | "private-marker"
    | "private-list"
    | "private-list-unreadable"
    | "links-private"
    | "links-outside"
    | "real-value";
  /** A message for the Project Docs view; contains no real value. */
  readonly message: string;
  /** For `real-value`: the placeholder whose real value was found. */
  readonly placeholder?: string;
  /** For link reasons: the link as written. */
  readonly link?: string;
}

/** What may happen to a vault change. */
export type GuardVerdict =
  | { readonly action: "allow" }
  | { readonly action: "vaultOnly"; readonly reasons: readonly GuardReason[] }
  | { readonly action: "holdBack"; readonly reasons: readonly GuardReason[] };

/** Everything the guards need to know about the link and the vault. */
export interface GuardContext {
  /** The private subfolder's key prefix within the project folder (`private` by default). */
  readonly privateSubfolder: string;
  readonly linkNoteKey?: string | undefined;
  readonly privateFiles: PrivateFilesList | typeof INVALID_PRIVATE_FILES;
  readonly allowLinksOutside: boolean;
  /** The repo's PRIVATE.md mapping, or null when there is none. */
  readonly mapping: PrivateMdMapping | null;
  readonly resolver: LinkResolver;
  /** Whether the vault note at `key` carries the `private` marker. */
  readonly isPrivateNote: (key: string) => boolean;
}

/** A proposed vault-to-repo change. `text` is the new content of a Markdown file. */
export interface VaultChange {
  readonly key: string;
  readonly kind: "markdown" | "attachment";
  readonly hash: string;
  readonly text?: string | undefined;
}

/** True when `key` is inside the private subfolder. */
export function inPrivateSubfolder(key: string, privateSubfolder: string): boolean {
  return (
    privateSubfolder !== "" && (key === privateSubfolder || key.startsWith(`${privateSubfolder}/`))
  );
}

/** Decides what may happen to one vault change. */
export function checkVaultChange(change: VaultChange, ctx: GuardContext): GuardVerdict {
  const vaultOnly: GuardReason[] = [];
  if (isNeverSynced(change.key)) {
    vaultOnly.push({ code: "never-synced", message: `${change.key} never syncs` });
  }
  if (change.key === ctx.linkNoteKey) {
    vaultOnly.push({
      code: "link-note",
      message: `${change.key} is the project's link note, which records a local path`,
    });
  }
  if (inPrivateSubfolder(change.key, ctx.privateSubfolder)) {
    vaultOnly.push({
      code: "private-folder",
      message: `${change.key} is in the private folder`,
    });
  }
  if (
    change.kind === "markdown" &&
    change.text !== undefined &&
    readRule(change.text) === "private"
  ) {
    vaultOnly.push({ code: "private-marker", message: `${change.key} is marked private` });
  }
  if (change.kind === "attachment") {
    if (ctx.privateFiles === INVALID_PRIVATE_FILES) {
      return {
        action: "holdBack",
        reasons: [
          {
            code: "private-list-unreadable",
            message:
              "the private-files list can't be read, so attachments are held back until it's fixed",
          },
        ],
      };
    }
    if (ctx.privateFiles.paths.has(change.key) || ctx.privateFiles.hashes.has(change.hash)) {
      vaultOnly.push({
        code: "private-list",
        message: `${change.key} is on the private-files list`,
      });
    }
  }
  if (vaultOnly.length > 0) return { action: "vaultOnly", reasons: vaultOnly };

  if (change.kind !== "markdown" || change.text === undefined) return { action: "allow" };
  const held = [
    ...linkReasons(linkTargets(change.text, change.key, ctx.resolver), ctx),
    ...realValueReasons(change.text, ctx.mapping),
  ];
  return held.length > 0 ? { action: "holdBack", reasons: held } : { action: "allow" };
}

function isPrivateTarget(key: string, ctx: GuardContext): boolean {
  if (inPrivateSubfolder(key, ctx.privateSubfolder) || ctx.isPrivateNote(key)) return true;
  return ctx.privateFiles !== INVALID_PRIVATE_FILES && ctx.privateFiles.paths.has(key);
}

function linkReasons(targets: readonly ResolvedLink[], ctx: GuardContext): GuardReason[] {
  const reasons: GuardReason[] = [];
  for (const { link, resolution } of targets) {
    const written = link.kind === "wikilink" ? link.raw : link.path;
    if (resolution.where === "inside" && isPrivateTarget(resolution.key, ctx)) {
      reasons.push({
        code: "links-private",
        link: written,
        message: `links to a private note (${written}), whose name must not reach the repo`,
      });
    } else if (resolution.where === "outside" && !ctx.allowLinksOutside) {
      reasons.push({
        code: "links-outside",
        link: written,
        message: `links to a note outside the project folder (${written}); allow such links in the project's settings, or remove it`,
      });
    }
  }
  return reasons;
}

function realValueReasons(text: string, mapping: PrivateMdMapping | null): GuardReason[] {
  if (!mapping) return [];
  const seen = new Set<string>();
  const reasons: GuardReason[] = [];
  for (const finding of findRealValues(text, mapping)) {
    if (seen.has(finding.placeholder)) continue;
    seen.add(finding.placeholder);
    reasons.push({
      code: "real-value",
      placeholder: finding.placeholder,
      message: `contains the real value of \`${finding.placeholder}\` (line ${finding.line}); use the placeholder instead`,
    });
  }
  return reasons;
}

/** Something private in a repo doc, located so an editor can mark it. Contains no real value. */
export interface RepoDocFinding {
  readonly code: "links-private" | "real-value";
  /** UTF-16 offsets in the text. */
  readonly start: number;
  readonly end: number;
  readonly message: string;
  readonly placeholder?: string;
}

/**
 * Checks a repo doc for what must not be committed (REQ-13.0.5): links to private notes, and real
 * values from PRIVATE.md. The guards keep these from arriving through sync, but a doc can also be
 * edited in the repo directly, so the editor points them out before a commit.
 */
export function checkRepoDoc(text: string, key: string, ctx: GuardContext): RepoDocFinding[] {
  const findings: RepoDocFinding[] = [];
  for (const { link, resolution } of linkTargets(text, key, ctx.resolver)) {
    if (resolution.where !== "inside" || !isPrivateTarget(resolution.key, ctx)) continue;
    findings.push({
      code: "links-private",
      start: link.start,
      end: link.end,
      message: "Links to a private note, whose name must not be committed.",
    });
  }
  if (ctx.mapping) {
    for (const range of findRealValueRanges(text, ctx.mapping)) {
      findings.push({
        code: "real-value",
        start: range.start,
        end: range.end,
        placeholder: range.placeholder,
        message: `The real value of ${range.placeholder} from PRIVATE.md; use the placeholder instead.`,
      });
    }
  }
  return findings.sort((a, b) => a.start - b.start);
}
