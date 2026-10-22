/**
 * The link commands as VS Code presents them: "Link to Obsidian" with VS Code's prompts, "Unlink",
 * and the offer to re-link a repo this machine doesn't know the vault for.
 */
import * as vscode from "vscode";
import { detectWsl, readLink } from "@specdevship/project-docs-core";
import { runLinkFlow, type FlowResult, type Prompter } from "./flow.js";
import { removeLink } from "./linker.js";
import { knownVaults, type KnownVault } from "./vaults.js";

const LAST_VAULT = "projectDocs.lastVault";
const CHOOSE_FOLDER = "$(folder-opened) Choose another vault folder…";

/** VS Code's own prompts for the link flow. */
export const vscodePrompter: Prompter = {
  async docsFolder(defaultValue) {
    return vscode.window.showInputBox({
      title: "Link to Obsidian (1/3): docs folder",
      prompt: "The folder in this repo to keep in sync, relative to the repo root",
      value: defaultValue || "docs",
      ignoreFocusOut: true,
      validateInput: (value) => (value.trim() === "" ? "Enter a folder, like docs" : undefined),
    });
  },
  async vault(vaults: readonly KnownVault[], defaultPath) {
    const items: (vscode.QuickPickItem & { vaultPath?: string })[] = vaults.map((v) => ({
      label: v.name,
      description: v.path,
      vaultPath: v.path,
      picked: v.path === defaultPath,
    }));
    // The default goes first, so pressing Enter accepts it.
    items.sort((a, b) => Number(b.picked ?? false) - Number(a.picked ?? false));
    items.push({ label: CHOOSE_FOLDER });
    const picked = await vscode.window.showQuickPick(items, {
      title: "Link to Obsidian (2/3): vault",
      placeHolder:
        vaults.length > 0
          ? "Choose the vault to sync with"
          : "No vaults found; choose the vault folder",
      ignoreFocusOut: true,
    });
    if (!picked) return undefined;
    if (picked.vaultPath) return picked.vaultPath;
    const chosen = await vscode.window.showOpenDialog({
      canSelectFolders: true,
      canSelectFiles: false,
      openLabel: "Use this vault",
      title: "Choose the vault's folder",
    });
    return chosen?.[0]?.fsPath;
  },
  async vaultFolder(defaultValue) {
    return vscode.window.showInputBox({
      title: "Link to Obsidian (3/3): folder in the vault",
      prompt: "Where the docs go in the vault, relative to the vault",
      value: defaultValue,
      ignoreFocusOut: true,
      validateInput: (value) =>
        value.trim() === "" ? "Enter a folder, like Projects/my-repo" : undefined,
    });
  },
};

/** Runs the link flow for a repo with the given prompter, reporting the outcome to the user. */
export async function linkRepo(
  context: vscode.ExtensionContext,
  repoRoot: string,
  prompter: Prompter,
  afterLink: (repoRoot: string) => Promise<void>,
): Promise<FlowResult> {
  const result = await runLinkFlow(repoRoot, {
    prompter,
    knownVaults: () => knownVaults(detectWsl()),
    lastVault: context.globalState.get<string>(LAST_VAULT),
    rememberVault: (vaultRoot) =>
      Promise.resolve(context.globalState.update(LAST_VAULT, vaultRoot)),
    wsl: detectWsl(),
  });
  if (result.outcome === "refused") void vscode.window.showErrorMessage(result.message);
  if (result.outcome === "linked") await afterLink(repoRoot);
  return result;
}

/** Removes the link after confirming; every file stays where it is (REQ-1.0.5). */
export async function unlinkRepo(repoRoot: string, confirm = true): Promise<boolean> {
  if (confirm) {
    const answer = await vscode.window.showWarningMessage(
      "Stop syncing this repo with Obsidian? Every file stays where it is.",
      { modal: true },
      "Unlink",
    );
    if (answer !== "Unlink") return false;
  }
  await removeLink(repoRoot);
  return true;
}

/** If this repo is linked but this machine doesn't know the vault, offers to re-link (REQ-2.0.7). */
export async function offerRelink(repoRoot: string, relink: () => Promise<unknown>): Promise<void> {
  const state = await readLink(repoRoot);
  if (state.state !== "relink") return;
  const answer = await vscode.window.showInformationMessage(
    `This repo syncs with "${state.committed.vaultFolder}" in an Obsidian vault, but this machine doesn't know where that vault is.`,
    "Link it",
  );
  if (answer === "Link it") await relink();
}
