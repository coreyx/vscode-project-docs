/**
 * Node entry point of the Project Docs extension: registers commands, and runs a sync controller
 * for the workspace's repo while it's linked.
 */
import * as vscode from "vscode";
import { readLink, type SchedulerState } from "@specdevship/project-docs-core";
import { linkRepo, offerRelink, unlinkRepo, vscodePrompter } from "./link/commands.js";
import type { FlowResult, Prompter } from "./link/flow.js";
import { CONFLICT_SCHEME, ConflictResolver, ConflictVersionProvider } from "./conflicts/merge.js";
import {
  BulkSummaryProvider,
  ConflictNotifier,
  SUMMARY_SCHEME,
  promptBulk,
} from "./conflicts/prompts.js";
import { SyncController } from "./sync/controller.js";

/** What the extension exposes to its integration tests. */
export interface ProjectDocsApi {
  link(repoRoot: string, prompter: Prompter): Promise<FlowResult>;
  unlink(repoRoot: string): Promise<boolean>;
  /** The running controller, if the workspace's repo is linked. */
  controller(): SyncController | null;
  /** Opens and completes conflict resolutions. */
  readonly conflicts: ConflictResolver;
}

/** The workspace's repo: the first folder, which is where Project Docs looks for a link. */
function workspaceRepo(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

/** Called by VS Code when an activation event fires. */
export function activate(context: vscode.ExtensionContext): ProjectDocsApi {
  let controller: SyncController | null = null;
  const stateEmitter = new vscode.EventEmitter<SchedulerState>();
  context.subscriptions.push(stateEmitter, { dispose: () => controller?.dispose() });
  const conflicts = new ConflictResolver(() => controller);
  const notifier = new ConflictNotifier((key) => conflicts.open(key));
  const summary = new BulkSummaryProvider();
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(
      CONFLICT_SCHEME,
      new ConflictVersionProvider(() => controller?.linkedProject ?? null),
    ),
    vscode.workspace.registerTextDocumentContentProvider(SUMMARY_SCHEME, summary),
  );

  const updateContext = async (repoRoot: string | undefined) => {
    const linked = repoRoot ? (await readLink(repoRoot)).state === "linked" : false;
    await vscode.commands.executeCommand("setContext", "projectDocs.linked", linked);
  };

  /** Starts syncing `repoRoot`, replacing any controller already running. */
  const startController = async (repoRoot: string) => {
    await controller?.stop();
    controller?.dispose();
    controller = new SyncController(repoRoot);
    controller.onDidChangeState((state) => stateEmitter.fire(state));
    let previous: SchedulerState["state"] | null = null;
    controller.onDidChangeState((state) => {
      if (state.state === "error")
        void vscode.window.showErrorMessage(`Project Docs: ${state.message}`);
      // Ask once each time a pass is stopped by the bulk guard, not on every repeat.
      if (state.state === "bulk" && previous !== "bulk") void promptBulk(state, summary);
      previous = state.state;
    });
    controller.onDidPass((outcome) => notifier.onPass(outcome));
    await controller.start();
  };

  const stopController = async () => {
    await controller?.stop();
    controller?.dispose();
    controller = null;
  };

  const afterLink = async (repoRoot: string) => {
    await updateContext(repoRoot);
    await startController(repoRoot);
  };

  const api: ProjectDocsApi = {
    async link(repoRoot, prompter) {
      return linkRepo(context, repoRoot, prompter, afterLink);
    },
    async unlink(repoRoot) {
      if (controller?.repoRoot === repoRoot) await stopController();
      const done = await unlinkRepo(repoRoot, false);
      await updateContext(workspaceRepo());
      return done;
    },
    controller: () => controller,
    conflicts,
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("projectDocs.link", async () => {
      const repo = workspaceRepo();
      if (!repo) {
        void vscode.window.showErrorMessage(
          "Open the repo's folder first, then link it to Obsidian.",
        );
        return;
      }
      await linkRepo(context, repo, vscodePrompter, afterLink);
    }),
    vscode.commands.registerCommand("projectDocs.unlink", async () => {
      const repo = workspaceRepo();
      if (!repo) return;
      await stopController();
      if (await unlinkRepo(repo)) await updateContext(repo);
      else await startController(repo);
    }),
    vscode.commands.registerCommand("projectDocs.syncNow", () => controller?.syncNow()),
    vscode.commands.registerCommand("projectDocs.pause", () => controller?.pause()),
    vscode.commands.registerCommand("projectDocs.resume", () => controller?.resume()),
    vscode.commands.registerCommand("projectDocs.proceedBulk", () =>
      controller?.syncNow({ allowBulk: true }),
    ),
    vscode.commands.registerCommand("projectDocs.cancelBulk", () => controller?.cancelBulk()),
    vscode.commands.registerCommand("projectDocs.openConflict", (key: string) =>
      conflicts.open(key),
    ),
    vscode.commands.registerCommand("projectDocs.resolveConflict", (uri?: vscode.Uri) => {
      const target = uri ?? vscode.window.activeTextEditor?.document.uri;
      return target ? conflicts.completeFromOutput(target.fsPath) : false;
    }),
  );

  const repo = workspaceRepo();
  if (repo) {
    void (async () => {
      await updateContext(repo);
      const state = await readLink(repo);
      if (state.state === "linked") await startController(repo);
      else await offerRelink(repo, () => linkRepo(context, repo, vscodePrompter, afterLink));
    })();
  }
  return api;
}

/** Called by VS Code on shutdown; the controller's lock is released through the subscriptions. */
export function deactivate(): void {}
