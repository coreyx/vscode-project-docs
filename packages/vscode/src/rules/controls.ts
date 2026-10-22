/**
 * Changing sync rules with the mouse (REQ-9): the Explorer's context submenu, the current file's
 * rule in the status bar with a picker on click, and the offers to trash a copy that is no longer
 * synced (design decision 9).
 */
import * as vscode from "vscode";
import {
  FrontmatterError,
  readRule,
  setRule,
  type SyncOutcome,
  type SyncRule,
} from "@specdevship/project-docs-core";
import type { SyncController } from "../sync/controller.js";
import { RULE_CHOICES, minimalEdit, ruleKey, ruleStatusText } from "./choices.js";

/** Decodes UTF-8 and keeps a byte order mark, so the file is written back byte for byte. */
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/**
 * Writes `rule` into the file's frontmatter, changing only the `project-docs` property (REQ-9.2).
 * An open editor gets the edit in place, and is saved unless it already had unsaved changes.
 */
export async function applyRule(uri: vscode.Uri, rule: SyncRule): Promise<void> {
  const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
  if (open) {
    const before = open.getText();
    const after = setRule(before, rule);
    if (after === before) return;
    const wasDirty = open.isDirty;
    const { start, end, text } = minimalEdit(before, after);
    const edit = new vscode.WorkspaceEdit();
    edit.replace(uri, new vscode.Range(open.positionAt(start), open.positionAt(end)), text);
    await vscode.workspace.applyEdit(edit);
    if (!wasDirty) await open.save();
    return;
  }
  const before = decoder.decode(await vscode.workspace.fs.readFile(uri));
  const after = setRule(before, rule);
  if (after !== before) await vscode.workspace.fs.writeFile(uri, Buffer.from(after, "utf8"));
}

/** A problem item from the Project Docs view, or a key, as trash commands receive them. */
type TrashTarget = string | { readonly problem: { readonly path: string } };

/** Options for the trash commands; the notification's button already counts as confirmation. */
interface TrashOptions {
  readonly confirmed?: boolean;
}

/** Registers the rule controls and keeps the rule status bar item up to date. */
export class RuleControls implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem(
    "projectDocs.rule",
    vscode.StatusBarAlignment.Right,
    100,
  );
  private readonly disposables: vscode.Disposable[] = [this.item];
  /** Keys already offered, so a notification appears once per copy rather than on every pass. */
  private offered = new Set<string>();

  constructor(private readonly controller: () => SyncController | null) {
    this.item.name = "Project Docs Sync Rule";
    this.disposables.push(
      vscode.commands.registerCommand("projectDocs.setRule", (uri?: vscode.Uri) =>
        this.pick(uri ?? vscode.window.activeTextEditor?.document.uri),
      ),
      ...RULE_CHOICES.map((choice) =>
        vscode.commands.registerCommand(choice.command, (uri?: vscode.Uri) =>
          this.set(uri ?? vscode.window.activeTextEditor?.document.uri, choice.rule),
        ),
      ),
      vscode.commands.registerCommand(
        "projectDocs.trashRepoCopy",
        (target: TrashTarget, options?: TrashOptions) => this.trash("repo", target, options),
      ),
      vscode.commands.registerCommand(
        "projectDocs.trashVaultCopy",
        (target: TrashTarget, options?: TrashOptions) => this.trash("vault", target, options),
      ),
      vscode.window.onDidChangeActiveTextEditor(() => this.refresh()),
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (event.document === vscode.window.activeTextEditor?.document) this.refresh();
      }),
    );
  }

  /** The key of a file the rule controls apply to, or null. */
  private keyOf(uri: vscode.Uri | undefined): string | null {
    const project = this.controller()?.linkedProject;
    if (!project || !uri || uri.scheme !== "file") return null;
    return ruleKey(uri.fsPath, project.repo.root);
  }

  /** The status bar item's text while it's shown, for tests. */
  get statusText(): string | undefined {
    return this.visible ? this.item.text : undefined;
  }

  private visible = false;

  /** Shows the active file's rule, or hides the item for files rules don't apply to. */
  refresh(): void {
    const document = vscode.window.activeTextEditor?.document;
    this.visible = Boolean(document && this.keyOf(document.uri) !== null);
    if (!document || !this.visible) {
      this.item.hide();
      return;
    }
    const { text, tooltip } = ruleStatusText(readRule(document.getText()));
    this.item.text = text;
    this.item.tooltip = tooltip;
    this.item.command = {
      title: "Change sync rule",
      command: "projectDocs.setRule",
      arguments: [document.uri],
    };
    this.item.show();
  }

  /** Offers the rules in a picker, marking the current one (REQ-9.0.3). */
  private async pick(uri: vscode.Uri | undefined): Promise<void> {
    if (!uri || !this.applies(uri)) return;
    const current = readRule(decoder.decode(await vscode.workspace.fs.readFile(uri)));
    const chosen = await vscode.window.showQuickPick(
      RULE_CHOICES.map((choice) => ({
        ...choice,
        ...(choice.rule === current ? { description: "current" } : {}),
      })),
      { title: "Project Docs sync rule", placeHolder: "How should this file sync?" },
    );
    if (chosen) await this.set(uri, chosen.rule);
  }

  private async set(uri: vscode.Uri | undefined, rule: SyncRule): Promise<void> {
    if (!uri || !this.applies(uri)) return;
    try {
      await applyRule(uri, rule);
    } catch (error) {
      // TextDecoder throws a TypeError for a file that isn't UTF-8.
      const message =
        error instanceof FrontmatterError
          ? "its frontmatter can't be edited safely; fix it by hand"
          : error instanceof TypeError
            ? "it isn't UTF-8 text"
            : String(error);
      void vscode.window.showErrorMessage(`Project Docs can't set the rule: ${message}.`);
      return;
    }
    this.refresh();
  }

  /** True for a Markdown file in the linked docs folder; otherwise says why nothing happened. */
  private applies(uri: vscode.Uri): boolean {
    if (this.keyOf(uri) !== null) return true;
    void vscode.window.showInformationMessage(
      "Sync rules apply to Markdown files in the linked docs folder.",
    );
    return false;
  }

  /**
   * Moves the copy that is no longer synced to its side's trash: the repo copy of a note made
   * private (decision 9), or the vault copy of a repo-only file. Asks first unless already asked.
   */
  private async trash(side: "repo" | "vault", target: TrashTarget, options?: TrashOptions) {
    const controller = this.controller();
    if (!controller) return;
    const key = typeof target === "string" ? target : target.problem.path;
    if (!options?.confirmed) {
      const where = side === "repo" ? "the repo" : "the vault";
      const choice = await vscode.window.showWarningMessage(
        `Move ${where}'s copy of ${key} to the trash?`,
        { modal: true, detail: "It stays in the trash, so you can restore it." },
        "Move to Trash",
      );
      if (choice !== "Move to Trash") return;
    }
    await controller.exclusive((project) => project[side].trash(key));
  }

  /** Offers, once per file, to trash a copy a pass reported as no longer synced. */
  onPass(outcome: SyncOutcome): void {
    if (outcome.outcome !== "synced") return;
    const current = new Set<string>();
    for (const notice of outcome.plan.notices) {
      const side =
        notice.code === "no-longer-synced"
          ? "repo"
          : notice.code === "repo-only-vault-copy"
            ? "vault"
            : null;
      if (!side) continue;
      const id = `${side}:${notice.key}`;
      current.add(id);
      if (this.offered.has(id)) continue;
      const action = side === "repo" ? "Move Repo Copy to Trash" : "Move Vault Copy to Trash";
      void vscode.window.showInformationMessage(notice.message, action).then((choice) => {
        if (choice !== action) return;
        const command =
          side === "repo" ? "projectDocs.trashRepoCopy" : "projectDocs.trashVaultCopy";
        return vscode.commands.executeCommand(command, notice.key, { confirmed: true });
      });
    }
    this.offered = current;
  }

  dispose(): void {
    for (const disposable of this.disposables) disposable.dispose();
  }
}
