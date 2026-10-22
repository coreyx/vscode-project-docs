/**
 * Node entry point of the Project Docs extension: registers commands and wires the link service.
 * Watching and the sync controller arrive with spec/vscode-project-docs TASK-21.
 */
import * as vscode from "vscode";
import { openProject, readLink, syncOnce } from "@specdevship/project-docs-core";
import { linkRepo, offerRelink, unlinkRepo, vscodePrompter } from "./link/commands.js";
import type { FlowResult, Prompter } from "./link/flow.js";

/** What the extension exposes to its integration tests. */
export interface ProjectDocsApi {
  link(repoRoot: string, prompter: Prompter): Promise<FlowResult>;
  unlink(repoRoot: string): Promise<boolean>;
}

/** The workspace's repo: the first folder, which is where Project Docs looks for a link. */
function workspaceRepo(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

/** Moves a repo-side file to the operating system's trash, through VS Code (REQ-6.0.3). */
async function vscodeTrash(absolutePath: string): Promise<void> {
  await vscode.workspace.fs.delete(vscode.Uri.file(absolutePath), { useTrash: true });
}

async function updateContext(repoRoot: string | undefined): Promise<void> {
  const linked = repoRoot ? (await readLink(repoRoot)).state === "linked" : false;
  await vscode.commands.executeCommand("setContext", "projectDocs.linked", linked);
}

/** Runs the first sync after linking. */
async function firstSync(repoRoot: string): Promise<void> {
  const project = await openProject(repoRoot, { repoTrash: vscodeTrash });
  if ("problem" in project) {
    void vscode.window.showErrorMessage(project.message);
    return;
  }
  const outcome = await syncOnce(project, { owner: "vscode" });
  if (outcome.outcome === "synced") {
    void vscode.window.showInformationMessage(
      `Linked to Obsidian. ${outcome.result.applied} file${outcome.result.applied === 1 ? "" : "s"} synced.`,
    );
  }
}

/** Called by VS Code when an activation event fires. */
export function activate(context: vscode.ExtensionContext): ProjectDocsApi {
  const api: ProjectDocsApi = {
    async link(repoRoot, prompter) {
      const result = await linkRepo(context, repoRoot, prompter, firstSync);
      await updateContext(workspaceRepo());
      return result;
    },
    async unlink(repoRoot) {
      const done = await unlinkRepo(repoRoot, false);
      await updateContext(workspaceRepo());
      return done;
    },
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
      await linkRepo(context, repo, vscodePrompter, firstSync);
      await updateContext(repo);
    }),
    vscode.commands.registerCommand("projectDocs.unlink", async () => {
      const repo = workspaceRepo();
      if (repo && (await unlinkRepo(repo))) await updateContext(repo);
    }),
  );

  const repo = workspaceRepo();
  void updateContext(repo);
  if (repo) {
    void offerRelink(repo, async () => {
      await linkRepo(context, repo, vscodePrompter, firstSync);
      await updateContext(repo);
    });
  }
  return api;
}

/** Called by VS Code on shutdown. */
export function deactivate(): void {}
