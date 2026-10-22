/**
 * Resolving conflicts in VS Code (REQ-5.0.3, design decision 13): VS Code's merge editor, opened
 * through the internal `_open.mergeEditor` command that VS Code's Git extension uses, with a
 * conflict-marker file as the fallback should that command ever stop working.
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import {
  conflictVersions,
  hasConflictMarkers,
  mergeText,
  resolveConflict,
  sha256,
  versionText,
  type Project,
} from "@specdevship/project-docs-core";
import type { SyncController } from "../sync/controller.js";

/** URI scheme of the read-only base, repo and vault versions shown in the merge editor. */
export const CONFLICT_SCHEME = "project-docs-conflict";

/** Serves the three versions of a conflict, read from the conflict store. */
export class ConflictVersionProvider implements vscode.TextDocumentContentProvider {
  constructor(private readonly project: () => Project | null) {}

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const project = this.project();
    if (!project) return "";
    const key = uri.path.replace(/^\//, "");
    const side = new URLSearchParams(uri.query).get("side");
    const versions = await conflictVersions(project, key);
    if (!versions) return "";
    const bytes =
      side === "base" ? versions.base : side === "vault" ? versions.vault : versions.repo;
    return versionText(bytes) ?? "";
  }
}

function versionUri(key: string, side: "base" | "repo" | "vault"): vscode.Uri {
  return vscode.Uri.from({ scheme: CONFLICT_SCHEME, path: `/${key}`, query: `side=${side}` });
}

/** Opens conflicts and completes their resolution. */
export class ConflictResolver {
  /** Working output files, by path, to the key they resolve. */
  private readonly outputs = new Map<string, string>();

  constructor(private readonly controller: () => SyncController | null) {}

  /** The working output file of a merge in progress for `key`, if there is one. */
  outputFor(key: string): string | undefined {
    return [...this.outputs].find(([, k]) => k === key)?.[0];
  }

  private async updateContext(): Promise<void> {
    await vscode.commands.executeCommand("setContext", "projectDocs.mergeOutputs", [
      ...this.outputs.keys(),
    ]);
  }

  private outputPath(project: Project, key: string): string {
    return path.join(
      project.store.dir,
      "conflicts",
      "work",
      `${sha256(key).slice(0, 16)}-${path.basename(key)}`,
    );
  }

  /**
   * Opens the conflict for `key`: the merge editor for Markdown, a choice between the two versions
   * for an attachment. `forceFallback` is for tests of the conflict-marker path.
   */
  async open(
    key: string,
    options: { forceFallback?: boolean } = {},
  ): Promise<"merge-editor" | "markers" | "picked" | "none"> {
    const project = this.controller()?.linkedProject;
    if (!project) return "none";
    const versions = await conflictVersions(project, key);
    if (!versions) {
      void vscode.window.showInformationMessage(`${key} has no conflict to resolve.`);
      return "none";
    }
    if (versions.kind === "attachment")
      return this.pickAttachment(key, versions.repo, versions.vault);

    const output = this.outputPath(project, key);
    await mkdir(path.dirname(output), { recursive: true });
    const repoText = versionText(versions.repo) ?? "";
    await writeFile(output, repoText);
    this.outputs.set(output, key);
    await this.updateContext();

    if (!options.forceFallback) {
      try {
        await vscode.commands.executeCommand("_open.mergeEditor", {
          base: versions.base ? versionUri(key, "base") : versionUri(key, "repo"),
          input1: {
            uri: versionUri(key, "repo"),
            title: "Repo",
            description: key,
            detail: "VS Code",
          },
          input2: {
            uri: versionUri(key, "vault"),
            title: "Vault",
            description: key,
            detail: "Obsidian",
          },
          output: vscode.Uri.file(output),
        });
        return "merge-editor";
      } catch {
        // The internal command is gone or has changed: fall back to conflict markers.
      }
    }
    const merged = mergeText(
      versionText(versions.base) ?? "",
      repoText,
      versionText(versions.vault) ?? "",
    );
    await writeFile(output, merged.clean ? merged.text : merged.markedText);
    await vscode.window.showTextDocument(vscode.Uri.file(output));
    void vscode.window.showInformationMessage(
      `Resolve the conflict markers in ${key}, then choose "Complete Merge" in the editor's title bar.`,
    );
    return "markers";
  }

  private async pickAttachment(
    key: string,
    repo: Uint8Array,
    vault: Uint8Array,
  ): Promise<"picked" | "none"> {
    const choice = await vscode.window.showQuickPick(
      ["Keep the repo's version", "Keep the vault's version"],
      {
        title: `${key} changed differently on both sides`,
      },
    );
    if (!choice) return "none";
    await this.complete(key, choice.includes("repo") ? repo : vault);
    return "picked";
  }

  /**
   * Finishes a merge from its working file: refuses while conflict markers remain, then writes the
   * result to both sides (REQ-5.0.6).
   */
  async completeFromOutput(output: string): Promise<boolean> {
    const key = this.outputs.get(output);
    if (key === undefined) {
      void vscode.window.showErrorMessage("This file isn't a Project Docs merge in progress.");
      return false;
    }
    const open = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === output);
    if (open?.isDirty) await open.save();
    const text = await readFile(output, "utf8");
    if (hasConflictMarkers(text)) {
      void vscode.window.showErrorMessage(`${key} still has conflict markers; resolve them first.`);
      return false;
    }
    await this.complete(key, text);
    this.outputs.delete(output);
    await this.updateContext();
    await rm(output, { force: true });
    return true;
  }

  private async complete(key: string, resolution: string | Uint8Array): Promise<void> {
    const controller = this.controller();
    if (!controller) throw new Error("Project Docs isn't syncing this repo.");
    await controller.exclusive((project) => resolveConflict(project, key, resolution));
    void vscode.window.showInformationMessage(`${key} is resolved and synced.`);
  }
}
