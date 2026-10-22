/**
 * Integration tests of conflict resolution and the bulk guard inside VS Code (REQ-5, REQ-7).
 */
import * as assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import type { ProjectDocsApi } from "../../src/extension.js";

const ID = "specdevship.project-docs";

async function api(): Promise<ProjectDocsApi> {
  const extension = vscode.extensions.getExtension<ProjectDocsApi>(ID);
  assert.ok(extension);
  return extension.activate();
}

async function eventually(check: () => Promise<boolean> | boolean, ms: number): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < ms) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`not within ${ms} ms`);
}

const text = async (file: string) => {
  try {
    return (await readFile(file, "utf8")).replace(/\r\n/g, "\n");
  } catch {
    return null;
  }
};

describe("VS Code's merge editor command (design decision 13)", () => {
  it("still opens a merge editor; if this fails, the internal command has changed", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pd-int-merge-"));
    try {
      const file = (name: string, content: string) => {
        const p = path.join(root, name);
        return writeFile(p, content).then(() => vscode.Uri.file(p));
      };
      const [base, one, two, output] = await Promise.all([
        file("base.md", "a\n"),
        file("one.md", "b\n"),
        file("two.md", "c\n"),
        file("out.md", "b\n"),
      ]);
      await vscode.commands.executeCommand("_open.mergeEditor", {
        base,
        input1: { uri: one, title: "Repo" },
        input2: { uri: two, title: "Vault" },
        output,
      });
      await eventually(() => {
        // A merge editor tab's input has a base, two inputs and a result. (TabInputTextMerge
        // exists at runtime but isn't in the typings for the engine floor, so check the shape.)
        const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input as
          { base?: unknown; input1?: unknown; input2?: unknown; result?: unknown } | undefined;
        return Boolean(input?.base && input.input1 && input.input2 && input.result);
      }, 5_000);
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("conflicts and the bulk guard", function () {
  this.timeout(120_000);
  let root: string;
  let repo: string;
  let docs: string;
  let vaultFolder: string;
  let docsApi: ProjectDocsApi;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "pd-int-conflict-"));
    repo = path.join(root, "repo");
    docs = path.join(repo, "docs");
    const vault = path.join(root, "Vault");
    vaultFolder = path.join(vault, "Projects", "repo");
    await mkdir(docs, { recursive: true });
    await mkdir(vault, { recursive: true });
    spawnSync("git", ["init", "-q", repo]);
    docsApi = await api();
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
    await rm(root, { recursive: true, force: true });
  });

  async function conflict() {
    await writeFile(path.join(docs, "a.md"), "line\n");
    await eventually(async () => (await text(path.join(vaultFolder, "a.md"))) === "line\n", 5_000);
    await docsApi.controller()?.pause();
    await writeFile(path.join(docs, "a.md"), "repo line\n");
    await writeFile(path.join(vaultFolder, "a.md"), "vault line\n");
    await docsApi.controller()?.resume();
    await eventually(() => docsApi.controller()?.state.state === "attention", 5_000);
  }

  it("resolves a conflict in the merge editor and syncs normally after (REQ-5.2, 5.3)", async () => {
    await conflict();
    assert.equal(await text(path.join(vaultFolder, "a.md")), "repo line\n");
    assert.equal(await docsApi.conflicts.open("a.md"), "merge-editor");
    const output = docsApi.conflicts.outputFor("a.md");
    assert.ok(output);
    // What the user would produce in the merge editor.
    await writeFile(output, "repo line\nvault line\n");
    assert.equal(await docsApi.conflicts.completeFromOutput(output), true);
    assert.equal(await text(path.join(docs, "a.md")), "repo line\nvault line\n");
    assert.equal(await text(path.join(vaultFolder, "a.md")), "repo line\nvault line\n");

    await writeFile(path.join(vaultFolder, "a.md"), "repo line\nvault line\nmore\n");
    await eventually(
      async () => (await text(path.join(docs, "a.md"))) === "repo line\nvault line\nmore\n",
      5_000,
    );
  });

  it("falls back to conflict markers, and won't complete while any remain", async () => {
    await conflict();
    assert.equal(await docsApi.conflicts.open("a.md", { forceFallback: true }), "markers");
    const output = docsApi.conflicts.outputFor("a.md");
    assert.ok(output);
    assert.match((await text(output)) ?? "", /<<<<<<< repo/);
    assert.equal(await docsApi.conflicts.completeFromOutput(output), false);
    await writeFile(output, "chose the vault line\n");
    assert.equal(await docsApi.conflicts.completeFromOutput(output), true);
    assert.equal(await text(path.join(docs, "a.md")), "chose the vault line\n");
  });

  it("waits at the bulk guard, and changes nothing until told to proceed (REQ-7.1, 7.2)", async () => {
    for (let i = 0; i < 30; i++) await writeFile(path.join(docs, `d${i}.md`), `${i}\n`);
    await eventually(async () => (await text(path.join(vaultFolder, "d29.md"))) === "29\n", 10_000);
    for (let i = 0; i < 25; i++) await rm(path.join(docs, `d${i}.md`));
    await eventually(() => docsApi.controller()?.state.state === "bulk", 10_000);
    assert.equal(await text(path.join(vaultFolder, "d0.md")), "0\n");

    await vscode.commands.executeCommand("projectDocs.cancelBulk");
    assert.equal(docsApi.controller()?.state.state, "idle");
    assert.equal(await text(path.join(vaultFolder, "d0.md")), "0\n");

    await vscode.commands.executeCommand("projectDocs.proceedBulk");
    await eventually(async () => (await text(path.join(vaultFolder, "d0.md"))) === null, 10_000);
  });
});
