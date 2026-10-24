/**
 * Privacy problems in the repo's docs (REQ-13.0.5): links to private notes and real values from
 * PRIVATE.md, shown in the Problems panel so they're seen before a commit; and the offer to replace
 * real values with placeholders in a change the guards held back (REQ-13.0.3).
 */
import * as path from "node:path";
import * as vscode from "vscode";
import {
  checkRepoDoc,
  decodeUtf8,
  inNodeModules,
  isExcludedFolder,
  isMarkdown,
  privacyContext,
  replaceRealValuesInVault,
  type GuardContext,
  type RepoDocFinding,
  type SyncOutcome,
} from "@specdevship/project-docs-core";
import type { SyncController } from "../sync/controller.js";
import { offsetToPosition } from "./positions.js";

/** A file's text as last read from disk, kept so unchanged files aren't read again. */
interface CachedText {
  readonly size: number;
  readonly mtimeMs: number;
  readonly text: string | null;
}

/** Keeps the Problems panel's privacy diagnostics for the linked docs folder up to date. */
export class PrivacyDiagnostics implements vscode.Disposable {
  private readonly collection = vscode.languages.createDiagnosticCollection("projectDocs");
  private readonly disposables: vscode.Disposable[] = [this.collection];
  private readonly texts = new Map<string, CachedText>();
  private ctx: GuardContext | null = null;
  private refreshing: Promise<void> = Promise.resolve();
  private typing: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly controller: () => SyncController | null) {
    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument((event) => this.onEdit(event.document)),
      // PRIVATE.md sits at the repo root, outside the watched docs folder.
      vscode.workspace.onDidSaveTextDocument((document) => {
        if (path.basename(document.uri.fsPath) === "PRIVATE.md") void this.refresh();
      }),
    );
  }

  /**
   * Rechecks every Markdown file in the docs folder, reading only files that changed since the last
   * check. Runs after each pass, when the vault's private notes or PRIVATE.md may have changed.
   */
  refresh(): Promise<void> {
    this.refreshing = this.refreshing.then(() => this.recheck()).catch(() => undefined);
    return this.refreshing;
  }

  private async recheck(): Promise<void> {
    const project = this.controller()?.linkedProject;
    if (!project) {
      this.ctx = null;
      this.texts.clear();
      this.collection.clear();
      return;
    }
    this.ctx = await privacyContext(project);
    const seen = new Set<string>();
    // Only what the link syncs: the docs folder and the root files (design decision 21).
    const skipFolder = (key: string) =>
      isExcludedFolder(key) || inNodeModules(key) || !project.scope.mayContain(key);
    for await (const entry of project.repo.list(skipFolder)) {
      if (entry.kind !== "file" || !isMarkdown(entry.key) || !project.scope.includes(entry.key))
        continue;
      seen.add(entry.key);
      const cached = this.texts.get(entry.key);
      if (cached?.size !== entry.size || cached.mtimeMs !== entry.mtimeMs) {
        const text = decodeUtf8(await project.repo.read(entry.key));
        this.texts.set(entry.key, { size: entry.size, mtimeMs: entry.mtimeMs, text });
      }
    }
    for (const key of this.texts.keys()) if (!seen.has(key)) this.texts.delete(key);

    this.collection.clear();
    for (const [key, { text }] of this.texts) {
      const uri = vscode.Uri.file(path.join(project.repo.root, ...key.split("/")));
      // An open editor's unsaved text is what the user is looking at, so check that instead.
      const open = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === uri.fsPath);
      const current = open?.isDirty ? open.getText() : text;
      if (current !== null) this.show(uri, key, current);
    }
  }

  /** Rechecks a doc as it's typed, once typing pauses. */
  private onEdit(document: vscode.TextDocument): void {
    const project = this.controller()?.linkedProject;
    if (!project || !this.ctx || document.uri.scheme !== "file") return;
    const key = path.relative(project.repo.root, document.uri.fsPath).split(path.sep).join("/");
    if (key.startsWith("..") || path.isAbsolute(key) || !isMarkdown(key)) return;
    if (!project.scope.includes(key)) return;
    if (this.typing !== null) clearTimeout(this.typing);
    this.typing = setTimeout(() => {
      this.typing = null;
      this.show(document.uri, key, document.getText());
    }, 300);
  }

  private show(uri: vscode.Uri, key: string, text: string): void {
    if (!this.ctx) return;
    const diagnostics = checkRepoDoc(text, key, this.ctx).map((f) => diagnostic(text, f));
    this.collection.set(uri, diagnostics);
  }

  dispose(): void {
    if (this.typing !== null) clearTimeout(this.typing);
    for (const disposable of this.disposables) disposable.dispose();
  }
}

/** Builds a Problems-panel entry; the message names the placeholder, never the real value. */
function diagnostic(text: string, finding: RepoDocFinding): vscode.Diagnostic {
  const start = offsetToPosition(text, finding.start);
  const end = offsetToPosition(text, finding.end);
  const result = new vscode.Diagnostic(
    new vscode.Range(start.line, start.character, end.line, end.character),
    finding.message,
    finding.code === "real-value"
      ? vscode.DiagnosticSeverity.Error
      : vscode.DiagnosticSeverity.Warning,
  );
  result.source = "Project Docs";
  result.code = finding.code;
  return result;
}

/** Options for the replace command; the notification's button already counts as confirmation. */
interface FixOptions {
  readonly confirmed?: boolean;
}

/**
 * The offer to replace real values with placeholders in a held-back change, from a notification
 * when a pass first holds it back, or from the Project Docs view.
 */
export class RealValueFix implements vscode.Disposable {
  private readonly command: vscode.Disposable;
  private offered = new Set<string>();

  constructor(private readonly controller: () => SyncController | null) {
    this.command = vscode.commands.registerCommand(
      "projectDocs.replaceRealValues",
      (target: string | { readonly problem: { readonly path: string } }, options?: FixOptions) =>
        this.replace(typeof target === "string" ? target : target.problem.path, options),
    );
  }

  /** Replaces the vault copy's real values, then syncs. Returns whether anything was replaced. */
  async replace(key: string, options?: FixOptions): Promise<boolean> {
    const controller = this.controller();
    if (!controller) return false;
    if (!options?.confirmed) {
      const choice = await vscode.window.showWarningMessage(
        `Replace the real values in the vault's copy of ${key} with their placeholders?`,
        { modal: true, detail: "Only the vault copy changes. The edit then syncs to the repo." },
        "Replace",
      );
      if (choice !== "Replace") return false;
    }
    const replaced = await controller.exclusive((project) =>
      replaceRealValuesInVault(project, key),
    );
    if (!replaced) {
      void vscode.window.showWarningMessage(
        `Project Docs couldn't replace the real values in ${key}: they're part of longer words. Edit it by hand.`,
      );
    }
    return replaced;
  }

  /** Offers the fix once for each change a pass newly holds back for real values. */
  onPass(outcome: SyncOutcome): void {
    if (outcome.outcome !== "synced") return;
    const current = new Set<string>();
    for (const notice of outcome.plan.notices) {
      if (notice.fix !== "replace-real-values") continue;
      current.add(notice.key);
      if (this.offered.has(notice.key)) continue;
      const action = "Replace with Placeholders";
      void vscode.window
        .showWarningMessage(
          `${notice.key} contains a real value from PRIVATE.md, so the change isn't synced to the repo.`,
          action,
        )
        .then((choice) =>
          choice === action ? this.replace(notice.key, { confirmed: true }) : undefined,
        );
    }
    this.offered = current;
  }

  dispose(): void {
    this.command.dispose();
  }
}
