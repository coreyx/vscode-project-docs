/**
 * The "Link to Obsidian" flow (REQ-1.0.1): three questions, each with a usable default, then the
 * link is created. A fourth is asked only when the docs folder holds folders of notes that git
 * ignores, to keep syncing the ones the user picks (REQ-1.0.6). The questions are asked through a
 * `Prompter`, so the flow runs the same with VS Code's prompts or a test's scripted answers.
 */
import { access } from "node:fs/promises";
import * as path from "node:path";
import {
  DEFAULT_SETTINGS,
  findIgnoredNoteFolders,
  readLink,
  syncIgnoredPattern,
  type CommittedLink,
  type WslContext,
} from "@specdevship/project-docs-core";
import { LinkError, createLink } from "./linker.js";
import type { KnownVault } from "./vaults.js";

/** Asks the user; `undefined` means they cancelled. */
export interface Prompter {
  docsFolder(defaultValue: string): Promise<string | undefined>;
  vault(
    vaults: readonly KnownVault[],
    defaultPath: string | undefined,
  ): Promise<string | undefined>;
  vaultFolder(defaultValue: string): Promise<string | undefined>;
  /**
   * Which of the docs folder's git-ignored folders of notes to keep syncing, with none picked to
   * begin with. Asked only when there are any; a prompter without it keeps none of them.
   */
  ignoredFolders?(folders: readonly string[]): Promise<readonly string[] | undefined>;
}

/** What the flow needs from its surroundings. */
export interface FlowContext {
  readonly prompter: Prompter;
  readonly knownVaults: () => Promise<KnownVault[]>;
  /** The vault chosen last time, offered first (REQ-1.2). */
  readonly lastVault: string | undefined;
  readonly rememberVault: (vaultRoot: string) => Promise<void>;
  readonly wsl: WslContext | null;
}

/** The outcome of the flow. */
export type FlowResult =
  | { readonly outcome: "linked"; readonly repoRoot: string }
  | { readonly outcome: "cancelled" }
  | { readonly outcome: "refused"; readonly message: string };

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

/** Links `repoRoot`, or re-links it to the folder its committed record names (REQ-2.0.7). */
export async function runLinkFlow(repoRoot: string, ctx: FlowContext): Promise<FlowResult> {
  const existing = await readLink(repoRoot);
  const relink: CommittedLink | undefined =
    existing.state === "relink" ? existing.committed : undefined;

  const docsDefault =
    relink?.docsFolder ?? ((await exists(path.join(repoRoot, "docs"))) ? "docs" : "");
  const docsFolder = relink ? relink.docsFolder : await ctx.prompter.docsFolder(docsDefault);
  if (docsFolder === undefined) return { outcome: "cancelled" };

  // A re-link keeps the settings already recorded, so it asks nothing about them.
  let syncIgnored: string[] = [];
  if (!relink && ctx.prompter.ignoredFolders) {
    const folders = await findIgnoredNoteFolders(repoRoot, docsFolder);
    if (folders.length > 0) {
      const kept = await ctx.prompter.ignoredFolders(folders);
      if (kept === undefined) return { outcome: "cancelled" };
      syncIgnored = kept.map((folder) => syncIgnoredPattern(`${folder}/`));
    }
  }

  const vaults = await ctx.knownVaults();
  const defaultVault = ctx.lastVault ?? vaults[0]?.path;
  const vaultRoot = await ctx.prompter.vault(vaults, defaultVault);
  if (vaultRoot === undefined) return { outcome: "cancelled" };

  const folderDefault = relink?.vaultFolder ?? `Projects/${path.basename(repoRoot)}`;
  const vaultFolder = await ctx.prompter.vaultFolder(folderDefault);
  if (vaultFolder === undefined) return { outcome: "cancelled" };

  try {
    await createLink(
      {
        repoRoot,
        docsFolder,
        vaultRoot,
        vaultFolder,
        projectId: relink?.projectId,
        settings:
          relink?.settings ??
          (syncIgnored.length > 0 ? { ...DEFAULT_SETTINGS, syncIgnored } : undefined),
      },
      ctx.wsl,
    );
  } catch (error) {
    if (error instanceof LinkError) return { outcome: "refused", message: error.message };
    throw error;
  }
  await ctx.rememberVault(vaultRoot);
  return { outcome: "linked", repoRoot };
}
