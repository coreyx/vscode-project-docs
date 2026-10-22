/**
 * What the status bar and the Project Docs view say, and which action resolves each problem
 * (REQ-17). Plain functions with no VS Code dependency, so they can be unit-tested.
 */
import type { SchedulerState, StatusItem } from "@specdevship/project-docs-core";

/** The status bar item's text and tooltip. Text uses VS Code's `$(icon)` syntax. */
export interface StatusText {
  readonly text: string;
  readonly tooltip: string;
}

/** Describes the scheduler's state for the status bar (REQ-17.0.1). */
export function statusText(state: SchedulerState): StatusText {
  switch (state.state) {
    case "starting":
      return { text: "$(sync) Project Docs", tooltip: "Project Docs is starting" };
    case "syncing":
      return { text: "$(sync~spin) Syncing", tooltip: "Project Docs is syncing with Obsidian" };
    case "idle":
      return {
        text: "$(check) Up to date",
        tooltip: "Project Docs: the repo and the vault are in sync",
      };
    case "attention":
      return {
        text: `$(warning) ${state.count} need${state.count === 1 ? "s" : ""} attention`,
        tooltip: "Project Docs: some files need you; open the Project Docs view",
      };
    case "paused":
      return {
        text: "$(debug-pause) Paused",
        tooltip: "Project Docs sync is paused; click to see the view, or run Resume Sync",
      };
    case "bulk":
      return {
        text: "$(alert) Waiting for your OK",
        tooltip: `Project Docs paused a sync that would delete or overwrite ${state.plan.bulk.destructive} files`,
      };
    case "elsewhere":
      return {
        text: "$(lock) Syncing in another window",
        tooltip:
          state.heldBy?.owner === "cli"
            ? "A project-docs command is syncing this project"
            : `Another VS Code window${state.heldBy?.window ? ` (${state.heldBy.window})` : ""} is syncing this project`,
      };
    case "error":
      return { text: "$(error) Project Docs", tooltip: state.message };
  }
}

/** One problem from `status.json`, as the engine wrote it; the core owns its format. */
export type { StatusItem };

/** The action that resolves a problem, as a VS Code command and its arguments. */
export interface ResolveAction {
  readonly title: string;
  readonly command: string;
  readonly arguments: readonly unknown[];
}

/** The side whose copy of a file the user should look at for each kind of problem. */
function sideToOpen(kind: string): "repo" | "vault" {
  switch (kind) {
    case "held-back":
    case "repo-to-vault-edit":
    case "unconvertible-links":
    case "no-longer-synced":
      return "vault";
    default:
      return "repo";
  }
}

/**
 * The action that resolves a problem (REQ-17.0.2). Opening the file is the fix for problems the user
 * settles by editing it (an invalid rule, a held-back link, an unportable name); conflicts open the
 * merge editor; failing writes show the log. A file can exist on one side only (an invalid rule
 * written in Obsidian never reaches the repo), so `openFile` gets both copies, preferred first.
 */
export function resolveAction(
  item: StatusItem,
  roots: { repo: string; vault: string },
  join: (...parts: string[]) => string,
): ResolveAction {
  if (item.kind === "conflict") {
    return {
      title: "Resolve conflict",
      command: "projectDocs.openConflict",
      arguments: [item.path],
    };
  }
  if (item.kind === "write-failing") {
    return { title: "Show log", command: "projectDocs.showLog", arguments: [] };
  }
  const side = sideToOpen(item.kind);
  const parts = item.path.split("/");
  const repoCopy = join(roots.repo, ...parts);
  const vaultCopy = join(roots.vault, ...parts);
  return {
    title: `Open ${item.path}`,
    command: "projectDocs.openFile",
    arguments: side === "repo" ? [repoCopy, vaultCopy] : [vaultCopy, repoCopy],
  };
}

/** A short label for each kind of problem, shown after the file name. */
export function kindLabel(kind: string): string {
  const labels: Record<string, string> = {
    conflict: "conflict",
    "held-back": "held back",
    "delete-overridden": "delete kept",
    "no-longer-synced": "no longer synced",
    "repo-only-vault-copy": "vault copy left",
    "repo-to-vault-edit": "vault edit not sent",
    "unconvertible-links": "links left as written",
    "invalid-rule": "invalid rule",
    "case-clash": "names clash by case",
    "not-portable": "name not allowed",
    "scan-skipped": "skipped",
    "write-failing": "keeps failing",
  };
  return labels[kind] ?? kind;
}
