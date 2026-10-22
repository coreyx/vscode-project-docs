/**
 * "Open in Obsidian" (REQ-2.0.8, 2.0.9), and the Advanced URI deep-link setting: offered once when
 * the vault has the Advanced URI plugin, and applied whenever it's on, including when someone
 * turned it on by editing `.project-docs.json`.
 */
import { stat } from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { detectWsl, obsidianOpenUri, readLink, setDeepLinks } from "@specdevship/project-docs-core";

/** The Advanced URI plugin's folder inside a vault. */
const ADVANCED_URI_PLUGIN = path.join(".obsidian", "plugins", "obsidian-advanced-uri");

/** Remembers, per project, that the deep-link offer was answered. */
const offerKey = (projectId: string) => `projectDocs.deepLinkOfferAnswered.${projectId}`;

/** Opens the linked project in Obsidian, and keeps the deep-link setting applied. */
export class ObsidianLinks implements vscode.Disposable {
  private readonly command: vscode.Disposable;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly repoRoot: () => string | undefined,
  ) {
    this.command = vscode.commands.registerCommand("projectDocs.openInObsidian", async () => {
      const uri = await this.uri();
      if (uri) await vscode.env.openExternal(vscode.Uri.parse(uri));
      else void vscode.window.showErrorMessage("Link this repo to Obsidian first.");
    });
  }

  /**
   * The link "Open in Obsidian" follows: the Advanced URI deep link while that setting is on, which
   * finds the folder note by its `uid` wherever it has moved; otherwise Obsidian's own link to the
   * link note's path, built from the machine-local record.
   */
  async uri(): Promise<string | null> {
    const repo = this.repoRoot();
    const state = repo ? await readLink(repo) : null;
    if (state?.state !== "linked") return null;
    if (state.committed.settings.advancedUriDeepLinks && state.committed.deepLink) {
      return state.committed.deepLink;
    }
    return obsidianOpenUri(state.local.linkNotePath, detectWsl());
  }

  /**
   * Brings the deep link and the folder note's `uid` in line with the setting, then, if the vault
   * has Advanced URI and the setting is off, offers once to turn it on.
   */
  async reconcile(): Promise<void> {
    const repo = this.repoRoot();
    const state = repo ? await readLink(repo) : null;
    if (!repo || state?.state !== "linked") return;
    const { committed, local } = state;
    const on = committed.settings.advancedUriDeepLinks;
    if (on !== (committed.deepLink !== undefined)) {
      await setDeepLinks(repo, committed, local, on);
      return;
    }
    if (on || this.context.globalState.get<boolean>(offerKey(committed.projectId))) return;
    const hasPlugin = await stat(path.join(local.vaultRoot, ADVANCED_URI_PLUGIN)).then(
      () => true,
      () => false,
    );
    if (!hasPlugin) return;
    const choice = await vscode.window.showInformationMessage(
      "This vault has the Advanced URI plugin. Turn on deep links, so Open in Obsidian finds this project's folder note even after the folder is renamed or moved?",
      "Turn On",
      "Don't Ask Again",
    );
    if (choice === undefined) return;
    await this.context.globalState.update(offerKey(committed.projectId), true);
    if (choice === "Turn On") await setDeepLinks(repo, committed, local, true);
  }

  dispose(): void {
    this.command.dispose();
  }
}
