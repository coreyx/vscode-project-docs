/**
 * Integration tests of the status bar's state and the Project Docs view (REQ-17.1): each kind of
 * problem appears with an action that works.
 */
import * as assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import type { ProjectDocsApi } from "../../src/extension.js";

const ID = "specdevship.project-docs";

async function eventually(check: () => Promise<boolean> | boolean, ms: number): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < ms) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`not within ${ms} ms`);
}

describe("the Project Docs view", function () {
  this.timeout(60_000);
  let root: string;
  let repo: string;
  let docs: string;
  let vaultFolder: string;
  let docsApi: ProjectDocsApi;

  before(async () => {
    root = await mkdtemp(path.join(tmpdir(), "pd-int-views-"));
    repo = path.join(root, "repo");
    docs = path.join(repo, "docs");
    const vault = path.join(root, "Vault");
    vaultFolder = path.join(vault, "Projects", "repo");
    await mkdir(docs, { recursive: true });
    await mkdir(vault, { recursive: true });
    spawnSync("git", ["init", "-q", repo]);
    await writeFile(
      path.join(repo, "PRIVATE.md"),
      "## Placeholders\n\n| `myhost` | `DESK-FAKE01` | host |\n",
    );
    const extension = vscode.extensions.getExtension<ProjectDocsApi>(ID);
    assert.ok(extension);
    docsApi = await extension.activate();
    await docsApi.link(repo, {
      docsFolder: async (value) => value,
      vault: async () => vault,
      vaultFolder: async (value) => value,
    });
    await eventually(() => docsApi.controller()?.state.state === "idle", 10_000);
  });

  after(async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    await docsApi.unlink(repo);
    await rm(root, { recursive: true, force: true });
  });

  it("lists conflicts, invalid rules, held-back changes and skipped files, each with a working action", async () => {
    // A conflict (REQ-5).
    await writeFile(path.join(docs, "conflict.md"), "line\n");
    await eventually(() => docsApi.controller()?.state.state === "idle", 5_000);
    await docsApi.controller()?.pause();
    await writeFile(path.join(docs, "conflict.md"), "repo\n");
    await writeFile(path.join(vaultFolder, "conflict.md"), "vault\n");
    // An invalid rule (REQ-8), a held-back real value (REQ-13), a file that isn't UTF-8 (REQ-16).
    await writeFile(path.join(vaultFolder, "rule.md"), "---\nproject-docs: typo\n---\n");
    await writeFile(path.join(vaultFolder, "secret.md"), "ssh DESK-FAKE01\n");
    await writeFile(path.join(docs, "latin1.md"), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));
    await docsApi.controller()?.resume();
    await eventually(() => docsApi.problems.problems.length >= 4, 10_000);

    const kinds = new Map(docsApi.problems.problems.map((p) => [p.path, p.kind]));
    assert.equal(kinds.get("conflict.md"), "conflict");
    assert.equal(kinds.get("rule.md"), "invalid-rule");
    assert.equal(kinds.get("secret.md"), "held-back");
    assert.equal(kinds.get("latin1.md"), "scan-skipped");
    assert.equal(docsApi.controller()?.state.state, "attention");
    // The view never shows a real value.
    assert.ok(!JSON.stringify(docsApi.problems.problems).includes("DESK-FAKE01"));

    // Each item's action works: opening a file opens it in an editor...
    const items = docsApi.problems.getChildren();
    const rule = items.find((i) => i.problem.path === "rule.md");
    assert.ok(rule?.command);
    await vscode.commands.executeCommand(rule.command.command, ...(rule.command.arguments ?? []));
    // Written in Obsidian with a bad rule, it never reached the repo, so the vault copy opens.
    assert.equal(
      vscode.window.activeTextEditor?.document.uri.fsPath,
      vscode.Uri.file(path.join(vaultFolder, "rule.md")).fsPath,
    );
    const held = items.find((i) => i.problem.path === "secret.md");
    assert.ok(held?.command);
    await vscode.commands.executeCommand(held.command.command, ...(held.command.arguments ?? []));
    assert.equal(
      vscode.window.activeTextEditor?.document.uri.fsPath,
      vscode.Uri.file(path.join(vaultFolder, "secret.md")).fsPath,
    );
    // ...and a conflict's opens the merge editor.
    const conflict = items.find((i) => i.problem.path === "conflict.md");
    assert.equal(conflict?.command?.command, "projectDocs.openConflict");
    assert.equal(
      await vscode.commands.executeCommand(
        conflict.command.command,
        ...(conflict.command.arguments ?? []),
      ),
      "merge-editor",
    );
  });

  it("opens the log, which never shows a real value (REQ-17.3)", async () => {
    await vscode.commands.executeCommand("projectDocs.showLog");
    const document = vscode.window.activeTextEditor?.document;
    assert.ok(document?.uri.fsPath.endsWith("project-docs.log"));
    const text = document?.getText() ?? "";
    assert.match(text, /pass: /);
    assert.ok(!text.includes("DESK-FAKE01"));
  });
});
