/**
 * "Open in Obsidian" (REQ-2.0.8, 2.0.9), and the Advanced URI deep-link setting: offered once when
 * the vault has the Advanced URI plugin, and turned on only once the user has seen and confirmed
 * both changes it makes (REQ-2.0.12, 2.0.13, design decision 18).
 */
import { stat } from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import {
  COMMITTED_FILE,
  deepLinkFor,
  detectWsl,
  obsidianOpenUri,
  readLink,
  readLinkNoteUid,
  setDeepLinks,
  setLinkNoteUid,
  type CommittedLink,
  type LocalLink,
} from "@specdevship/project-docs-core";

/** The Advanced URI plugin's folder inside a vault. */
const ADVANCED_URI_PLUGIN = path.join(".obsidian", "plugins", "obsidian-advanced-uri");

/** Remembers, per project, that the deep-link offer was answered. */
const offerKey = (projectId: string) => `projectDocs.deepLinkOfferAnswered.${projectId}`;

/** Remembers, per project, that adding the `uid` to this machine's folder note was answered. */
const uidKey = (projectId: string) => `projectDocs.deepLinkUidAnswered.${projectId}`;

/** The button that makes the changes a dialog lists. */
const CONFIRM = "Make These Changes";

/**
 * Answers for the dialogs, given by tests in place of a person. Each one stands for the user's
 * choice in the dialog it names; dialogs without an answer are shown as usual.
 */
export interface DeepLinkAnswers {
  /** The one-time offer: "Turn On…", or "Don't Ask Again". */
  readonly offer?: "turnOn" | "dontAsk";
  /** The dialog listing both changes. */
  readonly changes?: "confirm" | "cancel";
  /** Adding the `uid` on a machine whose folder note has none. */
  readonly uid?: "add" | "notNow";
}

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
   * The link "Open in Obsidian" follows: the Advanced URI deep link while the setting is on and
   * this machine's folder note carries the `uid` it looks up, so it finds the note wherever it has
   * moved. Otherwise Obsidian's own link to the link note's path, built from the machine-local
   * record, which works with no plugin and no `uid` (REQ-2.0.13).
   */
  async uri(): Promise<string | null> {
    const repo = this.repoRoot();
    const state = repo ? await readLink(repo) : null;
    if (state?.state !== "linked") return null;
    const { committed, local } = state;
    if (
      committed.settings.advancedUriDeepLinks &&
      committed.deepLink &&
      (await readLinkNoteUid(local.linkNotePath)) === committed.projectId
    ) {
      return committed.deepLink;
    }
    return obsidianOpenUri(local.linkNotePath, detectWsl());
  }

  /**
   * Brings the deep link in line with the setting, asking before any change is made:
   * - the setting turned on by hand, with no deep link yet: lists both changes, and makes both on
   *   confirmation; on Cancel, turns the setting back off, so it doesn't claim what isn't there;
   * - the setting on with a deep link (a teammate turned it on) but no `uid` in this machine's
   *   folder note: asks once whether to add it;
   * - the setting turned off by hand: removes the deep link, and leaves the harmless `uid`;
   * - the setting off, in a vault with Advanced URI: offers once to turn it on.
   */
  async reconcile(answers: DeepLinkAnswers = {}): Promise<void> {
    const repo = this.repoRoot();
    const state = repo ? await readLink(repo) : null;
    if (!repo || state?.state !== "linked") return;
    const { committed, local } = state;
    const on = committed.settings.advancedUriDeepLinks;
    const hasDeepLink = committed.deepLink !== undefined;

    if (!on && hasDeepLink) {
      await setDeepLinks(repo, committed, local, false);
      return;
    }
    if (on && !hasDeepLink) {
      const confirmed = await this.confirmChanges(committed, local, answers, true);
      await setDeepLinks(repo, committed, local, confirmed);
      return;
    }
    if (on) {
      await this.offerUid(committed, local, answers);
      return;
    }
    await this.offer(repo, committed, local, answers);
  }

  /** Asks, once per project, to add the `uid` that a deep link turned on elsewhere needs here. */
  private async offerUid(
    committed: CommittedLink,
    local: LocalLink,
    answers: DeepLinkAnswers,
  ): Promise<void> {
    const key = uidKey(committed.projectId);
    if ((await readLinkNoteUid(local.linkNotePath)) === committed.projectId) return;
    if (!answers.uid && this.context.globalState.get<boolean>(key)) return;
    const add = "Add uid";
    const choice =
      answers.uid === "add"
        ? add
        : answers.uid === "notNow"
          ? undefined
          : await vscode.window.showInformationMessage(
              `Deep links are on for this project. Add "uid: ${committed.projectId}" to your folder note, ${this.notePath(local)}, so Open in Obsidian can use them? Until then it opens the note by its path.`,
              add,
              "Not Now",
            );
    await this.context.globalState.update(key, true);
    if (choice === add) await setLinkNoteUid(local.linkNotePath, committed.projectId);
  }

  /** The one-time offer to turn deep links on, in a vault with the Advanced URI plugin. */
  private async offer(
    repo: string,
    committed: CommittedLink,
    local: LocalLink,
    answers: DeepLinkAnswers,
  ): Promise<void> {
    const key = offerKey(committed.projectId);
    if (!answers.offer && this.context.globalState.get<boolean>(key)) return;
    const hasPlugin = await stat(path.join(local.vaultRoot, ADVANCED_URI_PLUGIN)).then(
      () => true,
      () => false,
    );
    if (!hasPlugin) return;
    const turnOn = "Turn On…";
    const choice =
      answers.offer === "turnOn"
        ? turnOn
        : answers.offer === "dontAsk"
          ? "Don't Ask Again"
          : await vscode.window.showInformationMessage(
              "This vault has the Advanced URI plugin. Turn on deep links, so Open in Obsidian finds this project's folder note even after the folder is renamed or moved?",
              turnOn,
              "Don't Ask Again",
            );
    if (choice === undefined) return;
    await this.context.globalState.update(key, true);
    if (choice !== turnOn) return;
    if (await this.confirmChanges(committed, local, answers, false)) {
      await setDeepLinks(repo, committed, local, true);
    }
  }

  /**
   * Lists both changes turning deep links on makes, and returns whether the user confirmed them.
   * Both or neither: either one alone gives a broken or unused link.
   */
  private async confirmChanges(
    committed: CommittedLink,
    local: LocalLink,
    answers: DeepLinkAnswers,
    turnedOnByHand: boolean,
  ): Promise<boolean> {
    if (answers.changes) return answers.changes === "confirm";
    const cancel = turnedOnByHand
      ? "Cancel turns the setting back off."
      : "Cancel makes neither change.";
    const choice = await vscode.window.showWarningMessage(
      "Turn on Advanced URI deep links?",
      {
        modal: true,
        detail: [
          "Project Docs will make two changes:",
          "",
          `• ${COMMITTED_FILE}: add the deep link ${deepLinkFor(committed.projectId)}. This file is committed, so everyone who clones the repo gets it.`,
          `• ${this.notePath(local)} in your vault: add "uid: ${committed.projectId}", which the link looks the note up by.`,
          "",
          cancel,
        ].join("\n"),
      },
      CONFIRM,
    );
    return choice === CONFIRM;
  }

  /** The folder note's path within the vault, for messages. */
  private notePath(local: LocalLink): string {
    return path.relative(local.vaultRoot, local.linkNotePath).split(path.sep).join("/");
  }

  dispose(): void {
    this.command.dispose();
  }
}
