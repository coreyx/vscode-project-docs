/**
 * The status bar item and the Project Docs view (REQ-17.0.1, REQ-17.0.2), both driven by the sync
 * controller and the `status.json` each pass writes.
 */
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { statusFilePath, type SchedulerState } from "@specdevship/project-docs-core";
import type { SyncController } from "../sync/controller.js";
import { kindLabel, resolveAction, statusText, type StatusItem } from "./presentation.js";

/** Shows sync health in the status bar; a click opens the Project Docs view. */
export class StatusBar implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem(
    "projectDocs.status",
    vscode.StatusBarAlignment.Left,
    50,
  );

  constructor() {
    this.item.name = "Project Docs";
    this.item.command = "projectDocs.problems.focus";
  }

  show(state: SchedulerState | null): void {
    if (!state) {
      this.item.hide();
      return;
    }
    const { text, tooltip } = statusText(state);
    this.item.text = text;
    this.item.tooltip = tooltip;
    this.item.backgroundColor =
      state.state === "error"
        ? new vscode.ThemeColor("statusBarItem.errorBackground")
        : state.state === "attention" || state.state === "bulk"
          ? new vscode.ThemeColor("statusBarItem.warningBackground")
          : undefined;
    this.item.show();
  }

  dispose(): void {
    this.item.dispose();
  }
}

class ProblemItem extends vscode.TreeItem {
  constructor(
    readonly problem: StatusItem,
    roots: { repo: string; vault: string },
  ) {
    super(problem.path, vscode.TreeItemCollapsibleState.None);
    this.description = kindLabel(problem.kind);
    this.tooltip = new vscode.MarkdownString(
      [problem.message, ...problem.reasons.map((r) => `- ${r}`)].join("\n\n"),
    );
    // The fix, when there is one, is part of the context value so the view can offer it inline.
    this.contextValue = `projectDocs.problem.${problem.kind}${problem.fix ? `.${problem.fix}` : ""}`;
    this.iconPath = new vscode.ThemeIcon(problem.kind === "conflict" ? "git-merge" : "warning");
    const action = resolveAction(problem, roots, path.join);
    this.command = {
      title: action.title,
      command: action.command,
      arguments: [...action.arguments],
    };
  }
}

/** Lists every problem the last pass reported, each opening its fix when clicked. */
export class ProblemsView implements vscode.TreeDataProvider<ProblemItem> {
  private items: StatusItem[] = [];
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly controller: () => SyncController | null) {}

  /** Re-reads `status.json` after a pass. */
  async refresh(): Promise<void> {
    const project = this.controller()?.linkedProject;
    if (!project) {
      this.items = [];
    } else {
      try {
        const status = JSON.parse(await readFile(statusFilePath(project.vault.root), "utf8")) as {
          items?: StatusItem[];
        };
        this.items = status.items ?? [];
      } catch {
        this.items = [];
      }
    }
    this.emitter.fire();
  }

  /** The problems currently shown, for tests. */
  get problems(): readonly StatusItem[] {
    return this.items;
  }

  getTreeItem(element: ProblemItem): vscode.TreeItem {
    return element;
  }

  getChildren(): ProblemItem[] {
    const project = this.controller()?.linkedProject;
    if (!project) return [];
    const roots = { repo: project.repo.root, vault: project.vault.root };
    return this.items.map((item) => new ProblemItem(item, roots));
  }
}
