/**
 * Node entry point of the Project Docs extension: registers commands, and runs a sync controller
 * for the workspace's repo while it's linked.
 */
import * as vscode from "vscode";
import { readLink, type SchedulerState } from "@specdevship/project-docs-core";
import { linkRepo, offerRelink, unlinkRepo, vscodePrompter } from "./link/commands.js";
import type { FlowResult, Prompter } from "./link/flow.js";
import { SyncController } from "./sync/controller.js";

/** What the extension exposes to its integration tests. */
export interface ProjectDocsApi {
  link(repoRoot: string, prompter: Prompter): Promise<FlowResult>;
  unlink(repoRoot: string): Promise<boolean>;
  /** The running controller, if the workspace's repo is linked. */
  controller(): SyncController | null;
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
    controller.onDidChangeState((state) => {
      if (state.state === "error")
        void vscode.window.showErrorMessage(`Project Docs: ${state.message}`);
    });
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
