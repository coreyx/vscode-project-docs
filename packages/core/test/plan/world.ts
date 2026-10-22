/**
 * An in-memory world for planner tests: two sides as key -> content maps, an index, and a blob
 * store, turned into exactly the inputs `plan` takes.
 */
import { EMPTY_PRIVATE_FILES, type PrivateFilesList } from "../../src/guards/index.js";
import { createResolver } from "../../src/links/index.js";
import type { LinkSettings, PlanInput, SideTraits } from "../../src/plan/index.js";
import {
  detectLineEnding,
  isMarkdown,
  markdownHash,
  sha256,
  toLf,
  type Snapshot,
  type SnapshotEntry,
} from "../../src/scan/index.js";
import type { Index, IndexEntry } from "../../src/state/index.js";

export const PROJECT = "pd_3f2c9a1e-7b4d-4c1a-9e2f-5a6b7c8d9e0f";

export interface World {
  repo: Record<string, string>;
  vault: Record<string, string>;
  index: Record<string, IndexEntry>;
  blobs: Map<string, string>;
  settings: LinkSettings;
  repoTraits: SideTraits;
  vaultTraits: SideTraits;
  linkNoteKey?: string;
  privateFiles: PrivateFilesList | "invalid";
  mapping: Map<string, string> | null;
  /** Vault files outside the project folder, vault-relative. */
  outside: string[];
}

export function world(partial: Partial<World> = {}): World {
  return {
    repo: {},
    vault: {},
    index: {},
    blobs: new Map(),
    settings: {
      privateSubfolder: "private",
      syncAttachments: false,
      keepLinksAsWritten: false,
      allowLinksOutsideProjectFolder: false,
    },
    repoTraits: { isWindowsFs: false, caseInsensitive: false },
    vaultTraits: { isWindowsFs: false, caseInsensitive: false },
    privateFiles: EMPTY_PRIVATE_FILES,
    mapping: null,
    outside: [],
    ...partial,
  };
}

export function hashOf(key: string, content: string): string {
  return isMarkdown(key) ? markdownHash(content) : sha256(content);
}

function snapshot(side: "repo" | "vault", files: Record<string, string>, w: World): Snapshot {
  const entries = new Map<string, SnapshotEntry>();
  for (const [key, content] of Object.entries(files)) {
    const markdown = isMarkdown(key);
    if (!markdown && !w.settings.syncAttachments) continue;
    entries.set(key, {
      key,
      kind: markdown ? "markdown" : "attachment",
      hash: hashOf(key, content),
      lineEnding: markdown ? detectLineEnding(content) : "none",
      size: content.length,
      mtimeMs: 0,
      isLinkNote: side === "vault" && key === w.linkNoteKey,
    });
  }
  return { side, entries, skipped: [] };
}

/** Records `content` as the agreed base of `key` on both sides. */
export function agree(
  w: World,
  key: string,
  content: string,
  overrides: Partial<IndexEntry> = {},
): void {
  const hash = hashOf(key, content);
  w.blobs.set(hash, toLf(content));
  w.index[key] = {
    key,
    kind: isMarkdown(key) ? "markdown" : "attachment",
    baseHash: hash,
    repoLineEnding: isMarkdown(key) ? detectLineEnding(content) : "none",
    vaultLineEnding: isMarkdown(key) ? detectLineEnding(content) : "none",
    state: "synced",
    reasons: [],
    ...overrides,
  };
}

/** A file synced on both sides with the same content. */
export function synced(w: World, key: string, content: string): void {
  w.repo[key] = content;
  w.vault[key] = content;
  agree(w, key, content);
}

export function input(w: World): PlanInput {
  const index: Index = { format: 1, projectId: PROJECT, entries: w.index };
  const vaultFiles = [...Object.keys(w.vault).map((k) => `Projects/repo/${k}`), ...w.outside];
  return {
    repo: snapshot("repo", w.repo, w),
    vault: snapshot("vault", w.vault, w),
    index,
    settings: w.settings,
    repoTraits: w.repoTraits,
    vaultTraits: w.vaultTraits,
    linkNoteKey: w.linkNoteKey,
    privateFiles: w.privateFiles,
    mapping: w.mapping,
    resolver: createResolver({ projectFolder: "Projects/repo", files: vaultFiles }),
    readText: async (side, key) => (side === "repo" ? w.repo : w.vault)[key] ?? null,
    readBase: async (hash) => w.blobs.get(hash) ?? null,
  };
}
