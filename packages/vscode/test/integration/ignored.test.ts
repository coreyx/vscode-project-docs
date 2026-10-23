/**
 * Integration tests of notes that became ignored by git, in VS Code (REQ-3.0.8, AC 3.7): the
 * problem in the Project Docs view, and its Keep Syncing It and Stop Syncing It actions.
 */
import * as assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

const text = (file: string) =>
  readFile(file, "utf8").then(
    (t) => t.replace(/\r\n/g, "\n"),
    () => null,
  );

describe("notes that became ignored, in VS Code", function () {
  this.timeout(60_000);
  let root: string;
  let repo: string;
  let docs: string;
  let vaultFolder: string;
  let docsApi: ProjectDocsApi;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "pd-int-ignored-"));
    repo = path.join(root, "repo");
    docs = path.join(repo, "docs");
    const vault = path.join(root, "Vault");
    vaultFolder = path.join(vault, "Projects", "repo");
    await mkdir(path.join(docs, "drafts"), { recursive: true });
    await mkdir(vault, { recursive: true });
    spawnSync("git", ["init", "-q", repo]);
    // Enough other docs that bringing an edit across stays under the bulk guard's threshold.
    for (let i = 0; i < 10; i++) await writeFile(path.join(docs, `guide-${i}.md`), `guide ${i}\n`);
    await writeFile(path.join(docs, "drafts", "idea.md"), "idea\n");
    const extension = vscode.extensions.getExtension<ProjectDocsApi>(ID);
    assert.ok(extension);
    docsApi = await extension.activate();
    await docsApi.link(repo, {
      docsFolder: async (value) => value,
      vault: async () => vault,
      vaultFolder: async (value) => value,
    });
    await eventually(() => docsApi.controller()?.state.state === "idle", 10_000);
    assert.equal(await text(path.join(vaultFolder, "drafts", "idea.md")), "idea\n");

    // git begins to ignore the folder, and the note is edited in the vault meanwhile.
    await writeFile(path.join(repo, ".gitignore"), "/docs/drafts/\n.project-docs.local.json\n");
    await writeFile(path.join(vaultFolder, "drafts", "idea.md"), "idea, from the vault\n");
    // Run the pass directly: the watcher's timing is covered elsewhere, and is slow on CI runners.
    await vscode.commands.executeCommand("projectDocs.syncNow");
    await eventually(() => docsApi.problems.problems.some((p) => p.kind === "now-ignored"), 10_000);
  });

  afterEach(async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    await docsApi.unlink(repo);
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });

  /** The view's item for the ignored folder. */
  const folderItem = () => docsApi.problems.getChildren().find((i) => i.problem.path === "drafts/");

  it("shows one problem for the folder, and Keep Syncing It brings the edit across (AC 3.7)", async () => {
    const item = folderItem();
    assert.equal(item?.contextValue, "projectDocs.problem.now-ignored.sync-ignored");
    assert.equal(await text(path.join(docs, "drafts", "idea.md")), "idea\n");

    assert.equal(
      await vscode.commands.executeCommand("projectDocs.keepSyncingIgnored", item),
      true,
    );
    const committed = JSON.parse((await text(path.join(repo, ".project-docs.json"))) ?? "{}");
    assert.deepEqual(committed.settings.syncIgnored, ["/drafts/"]);
    await eventually(
      async () => (await text(path.join(docs, "drafts", "idea.md"))) === "idea, from the vault\n",
      5_000,
    );
    await eventually(() => docsApi.problems.problems.length === 0, 5_000);
  });

  it("clears the problem with Stop Syncing It, and leaves both copies as they are", async () => {
    assert.equal(
      await vscode.commands.executeCommand("projectDocs.stopSyncingIgnored", folderItem()),
      true,
    );
    await eventually(() => docsApi.problems.problems.length === 0, 5_000);
    assert.equal(await text(path.join(docs, "drafts", "idea.md")), "idea\n");
    assert.equal(await text(path.join(vaultFolder, "drafts", "idea.md")), "idea, from the vault\n");
  });
});
