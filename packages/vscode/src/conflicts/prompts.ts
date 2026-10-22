/**
 * Prompts that follow a pass: a new conflict to resolve (REQ-5.0.3), and the bulk guard's question
 * before a pass that would delete or overwrite many files (REQ-7).
 */
import * as vscode from "vscode";
import type { Action, Plan, SchedulerState, SyncOutcome } from "@specdevship/project-docs-core";

/** URI scheme of the read-only summary of what a guarded pass would do. */
export const SUMMARY_SCHEME = "project-docs-summary";

/** Describes the deletes and overwrites in a guarded plan, for "Show changes". */
export function bulkSummary(plan: Plan): string {
  const lines = [
    "# Changes waiting for your go-ahead",
    "",
    `This sync pass would delete or overwrite ${plan.bulk.destructive} files, more than the ${plan.bulk.threshold} that sync makes without asking. Nothing has changed yet.`,
    "",
  ];
  const describe = (a: Action): string | null => {
    switch (a.type) {
      case "trash":
        return `- Move \`${a.key}\` to the ${a.side}'s trash`;
      case "copy":
        return a.overwrites
          ? `- Replace \`${a.key}\` in the ${a.from === "repo" ? "vault" : "repo"} with the ${a.from}'s version`
          : null;
      case "writeBoth":
        return a.overwrites ? `- Write the merged \`${a.key}\` to both sides` : null;
      case "conflict":
        return `- Keep the repo's \`${a.key}\` and save the vault's version as a conflict`;
      default:
        return null;
    }
  };
  for (const action of plan.actions) {
    const line = describe(action);
    if (line) lines.push(line);
  }
  return `${lines.join("\n")}\n`;
}

/** Serves the summary of the plan currently waiting at the bulk guard. */
export class BulkSummaryProvider implements vscode.TextDocumentContentProvider {
  private plan: Plan | null = null;
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;
  static readonly uri = vscode.Uri.from({ scheme: SUMMARY_SCHEME, path: "/Changes waiting.md" });

  show(plan: Plan): void {
    this.plan = plan;
    this.emitter.fire(BulkSummaryProvider.uri);
  }

  provideTextDocumentContent(): string {
    return this.plan ? bulkSummary(this.plan) : "Nothing is waiting.\n";
  }
}

/** Asks about a pass the bulk guard stopped, once per guarded plan. */
export async function promptBulk(
  state: SchedulerState,
  summary: BulkSummaryProvider,
): Promise<void> {
  if (state.state !== "bulk") return;
  summary.show(state.plan);
  const choice = await vscode.window.showWarningMessage(
    `Project Docs paused: this sync would delete or overwrite ${state.plan.bulk.destructive} files.`,
    "Show changes",
    "Proceed",
    "Cancel",
  );
  if (choice === "Show changes") {
    await vscode.commands.executeCommand("markdown.showPreview", BulkSummaryProvider.uri);
  } else if (choice === "Proceed") {
    await vscode.commands.executeCommand("projectDocs.proceedBulk");
  } else if (choice === "Cancel") {
    await vscode.commands.executeCommand("projectDocs.cancelBulk");
  }
}

/** Tracks conflicts across passes and offers to resolve each new one. */
export class ConflictNotifier {
  private known = new Set<string>();

  constructor(private readonly open: (key: string) => Promise<unknown>) {}

  onPass(outcome: SyncOutcome): void {
    if (outcome.outcome !== "synced") return;
    const current = new Set(
      outcome.plan.notices.filter((n) => n.code === "conflict").map((n) => n.key),
    );
    for (const key of current) {
      if (this.known.has(key)) continue;
      void vscode.window
        .showWarningMessage(`${key} was edited differently in VS Code and Obsidian.`, "Resolve")
        .then((choice) => (choice === "Resolve" ? this.open(key) : undefined));
    }
    this.known = current;
  }
}
