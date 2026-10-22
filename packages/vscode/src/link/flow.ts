/**
 * The "Link to Obsidian" flow (REQ-1.0.1): at most three questions, each with a usable default,
 * then the link is created. The questions are asked through a `Prompter`, so the flow runs the
 * same with VS Code's prompts or a test's scripted answers.
 */
import { access } from "node:fs/promises";
import * as path from "node:path";
import { readLink, type CommittedLink, type WslContext } from "@specdevship/project-docs-core";
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
        settings: relink?.settings,
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
