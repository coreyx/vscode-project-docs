/**
 * Changing sync rules with the mouse (REQ-9): the Explorer's context submenu, the current file's
 * rule in the status bar with a picker on click, the offers to trash a copy that is no longer
 * synced (design decision 9), confirming that a note that was private may sync (decision 17), and
 * keeping or stopping the sync of notes that became ignored by git (decision 20).
 */
import * as vscode from "vscode";
import {
  FrontmatterError,
  confirmSyncable,
  keepSyncingIgnored,
  readRule,
  setRule,
  stopSyncingIgnored,
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

/** A problem item from the Project Docs view, or a key, as the problem actions receive them. */
type ProblemTarget = string | { readonly problem: { readonly path: string } };

/** Options for commands that ask first; a caller that already asked passes `confirmed`. */
interface ConfirmOptions {
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
        (target: ProblemTarget, options?: ConfirmOptions) => this.trash("repo", target, options),
      ),
      vscode.commands.registerCommand(
        "projectDocs.trashVaultCopy",
        (target: ProblemTarget, options?: ConfirmOptions) => this.trash("vault", target, options),
      ),
      vscode.commands.registerCommand(
        "projectDocs.confirmSyncable",
        (target: ProblemTarget, options?: ConfirmOptions) => this.confirmSyncable(target, options),
      ),
      vscode.commands.registerCommand("projectDocs.keepSyncingIgnored", (target: ProblemTarget) =>
        this.ignoredChoice(target, "sync"),
      ),
      vscode.commands.registerCommand("projectDocs.stopSyncingIgnored", (target: ProblemTarget) =>
        this.ignoredChoice(target, "stop"),
      ),
      vscode.window.onDidChangeActiveTextEditor(() => this.refresh()),
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (event.document === vscode.window.activeTextEditor?.document) this.refresh();
      }),
    );
  }

  /** The key of a file the rule controls apply to, or null: a synced Markdown file in scope. */
  private keyOf(uri: vscode.Uri | undefined): string | null {
    const project = this.controller()?.linkedProject;
    if (!project || !uri || uri.scheme !== "file") return null;
    const key = ruleKey(uri.fsPath, project.repo.root);
    return key !== null && project.scope.includes(key) ? key : null;
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
  private async trash(side: "repo" | "vault", target: ProblemTarget, options?: ConfirmOptions) {
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

  /**
   * Lets a note that stopped being private sync to the repo, after asking (REQ-10.0.7). Returns
   * whether it was released; the pass that follows copies it, with the other guards still applying.
   */
  private async confirmSyncable(target: ProblemTarget, options?: ConfirmOptions): Promise<boolean> {
    const controller = this.controller();
    const project = controller?.linkedProject;
    if (!controller || !project) return false;
    const key = typeof target === "string" ? target : target.problem.path;
    if (!options?.confirmed) {
      const repoPath = vscode.workspace.asRelativePath(
        vscode.Uri.joinPath(vscode.Uri.file(project.repo.root), ...key.split("/")),
      );
      const choice = await vscode.window.showWarningMessage(
        `Sync ${key} to the repo?`,
        {
          modal: true,
          detail: `${key} was private in the vault. Syncing it copies it into the repo as ${repoPath}, where it can be committed and pushed.`,
        },
        "Sync to Repo",
      );
      if (choice !== "Sync to Repo") return false;
    }
    return controller.exclusive((p) => confirmSyncable(p, key));
  }

  /**
   * Keeps syncing a folder or file that became ignored, by adding it to `syncIgnored` in
   * `.project-docs.json`, or stops syncing it, leaving both copies alone (design decision 20).
   * Neither asks first: keeping sends nothing that wasn't syncing before, and stopping changes no
   * file. Returns whether anything changed; the pass that follows picks it up.
   */
  private async ignoredChoice(target: ProblemTarget, choice: "sync" | "stop"): Promise<boolean> {
    const controller = this.controller();
    if (!controller?.linkedProject) return false;
    const key = typeof target === "string" ? target : target.problem.path;
    return controller.exclusive((p) =>
      choice === "sync" ? keepSyncingIgnored(p, key) : stopSyncingIgnored(p, key),
    );
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
