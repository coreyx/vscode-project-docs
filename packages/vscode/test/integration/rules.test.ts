/**
 * Integration tests of changing sync rules with the mouse (REQ-9) and the offers to trash a copy
 * that is no longer synced (design decision 9).
 */
import * as assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
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

const exists = (file: string) =>
  stat(file).then(
    () => true,
    () => false,
  );

describe("the rule menus (REQ-9.1)", () => {
  it("sets any rule in three clicks from the Explorer, and two from the status bar", () => {
    const manifest = vscode.extensions.getExtension(ID)?.packageJSON as {
      contributes: { menus: Record<string, { submenu?: string; command?: string }[]> };
    };
    const menus = manifest.contributes.menus;
    // Click 1 opens the context menu, which holds the submenu.
    const submenu = menus["explorer/context"]?.find((m) => m.submenu)?.submenu;
    assert.equal(submenu, "projectDocs.ruleMenu");
    // Click 2 opens the submenu; click 3 picks one of these.
    assert.deepEqual(
      menus["projectDocs.ruleMenu"]?.map((m) => m.command),
      [
        "projectDocs.setRule.sync",
        "projectDocs.setRule.repoToVault",
        "projectDocs.setRule.repoOnly",
      ],
    );
  });
});

describe("sync rules", function () {
  this.timeout(60_000);
  let root: string;
  let repo: string;
  let docs: string;
  let vaultFolder: string;
  /** The vault's copy of the docs folder: the vault folder mirrors the repo. */
  let vaultDocs: string;
  let docsApi: ProjectDocsApi;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "pd-int-rules-"));
    repo = path.join(root, "repo");
    docs = path.join(repo, "docs");
    const vault = path.join(root, "Vault");
    vaultFolder = path.join(vault, "Projects", "repo");
    vaultDocs = path.join(vaultFolder, "docs");
    await mkdir(docs, { recursive: true });
    await mkdir(vaultDocs, { recursive: true });
    spawnSync("git", ["init", "-q", repo]);
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

  afterEach(async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    await docsApi.unlink(repo);
    // VS Code briefly keeps watching the folder of a file it just closed, which Windows reports as busy.
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });

  it("writes only the property, leaving every other byte as it was (REQ-9.2)", async () => {
    const file = path.join(docs, "a.md");
    const before = "﻿---\r\ntitle: A  # kept\r\nproject-docs: sync\r\ntags: [x]\r\n---\r\nBody\r\n";
    await writeFile(file, before);
    await vscode.commands.executeCommand("projectDocs.setRule.repoOnly", vscode.Uri.file(file));
    assert.equal(
      await readFile(file, "utf8"),
      before.replace("project-docs: sync", "project-docs: repo-only"),
    );
  });

  it("edits an open file in place, saves it, and shows its rule in the status bar", async () => {
    const file = path.join(docs, "b.md");
    await writeFile(file, "# B\n");
    const editor = await vscode.window.showTextDocument(vscode.Uri.file(file));
    await eventually(() => docsApi.rules.statusText === "$(arrow-swap) sync", 5_000);
    await vscode.commands.executeCommand("projectDocs.setRule.repoToVault");
    assert.equal(editor.document.isDirty, false);
    assert.equal(await readFile(file, "utf8"), "---\nproject-docs: repo-to-vault\n---\n# B\n");
    assert.equal(docsApi.rules.statusText, "$(arrow-right) repo-to-vault");
  });

  it("hides the rule for files outside the docs folder", async () => {
    const file = path.join(repo, "README.md");
    await writeFile(file, "# Repo\n");
    await vscode.window.showTextDocument(vscode.Uri.file(file));
    await eventually(() => docsApi.rules.statusText === undefined, 5_000);
    await vscode.commands.executeCommand("projectDocs.setRule.repoOnly", vscode.Uri.file(file));
    assert.equal(await readFile(file, "utf8"), "# Repo\n");
  });

  it("offers to trash the repo copy of a note made private, and only that (decision 9)", async () => {
    await writeFile(path.join(docs, "c.md"), "C\n");
    await eventually(() => exists(path.join(vaultDocs, "c.md")), 5_000);
    await writeFile(path.join(vaultDocs, "c.md"), "---\nproject-docs: private\n---\nC\n");
    await eventually(
      () => docsApi.problems.problems.some((p) => p.kind === "no-longer-synced"),
      5_000,
    );
    // The repo copy stays until the user chooses.
    assert.equal(await readFile(path.join(docs, "c.md"), "utf8"), "C\n");
    await vscode.commands.executeCommand("projectDocs.trashRepoCopy", "docs/c.md", {
      confirmed: true,
    });
    assert.equal(await exists(path.join(docs, "c.md")), false);
    assert.ok(await exists(path.join(vaultDocs, "c.md")));
    await eventually(() => docsApi.problems.problems.length === 0, 5_000);
  });

  it("offers to trash the vault copy of a file made repo-only", async () => {
    const file = path.join(docs, "d.md");
    await writeFile(file, "D\n");
    await eventually(() => exists(path.join(vaultDocs, "d.md")), 5_000);
    await vscode.commands.executeCommand("projectDocs.setRule.repoOnly", vscode.Uri.file(file));
    await eventually(
      () => docsApi.problems.problems.some((p) => p.kind === "repo-only-vault-copy"),
      5_000,
    );
    assert.ok(await exists(path.join(vaultDocs, "d.md")));
    await vscode.commands.executeCommand("projectDocs.trashVaultCopy", "docs/d.md", {
      confirmed: true,
    });
    assert.equal(await exists(path.join(vaultDocs, "d.md")), false);
    assert.ok(await exists(path.join(vaultFolder, "..", "..", ".trash", "d.md")));
    assert.equal(await readFile(file, "utf8"), "---\nproject-docs: repo-only\n---\nD\n");
    await eventually(() => docsApi.problems.problems.length === 0, 5_000);
  });
});
