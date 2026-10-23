/**
 * Integration tests of privacy in VS Code (REQ-13): diagnostics on repo docs, and the fix for a
 * change held back for a real value.
 */
import * as assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import type { ProjectDocsApi } from "../../src/extension.js";

const ID = "specdevship.project-docs";
const REAL = "DESK-FAKE01";

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

describe("privacy in VS Code", function () {
  this.timeout(60_000);
  let root: string;
  let repo: string;
  let docs: string;
  let vaultFolder: string;
  let docsApi: ProjectDocsApi;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "pd-int-privacy-"));
    repo = path.join(root, "repo");
    docs = path.join(repo, "docs");
    const vault = path.join(root, "Vault");
    vaultFolder = path.join(vault, "Projects", "repo");
    await mkdir(docs, { recursive: true });
    await mkdir(vault, { recursive: true });
    spawnSync("git", ["init", "-q", repo]);
    await writeFile(
      path.join(repo, "PRIVATE.md"),
      `## Placeholders\n\n| \`myhost\` | \`${REAL}\` | host |\n`,
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

  afterEach(async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    await docsApi.unlink(repo);
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });

  it("shows a repo doc's real value and private link in the Problems panel (REQ-13.4)", async () => {
    await mkdir(path.join(vaultFolder, "private"));
    await writeFile(path.join(vaultFolder, "private", "server-notes.md"), "s\n");
    const file = path.join(docs, "guide.md");
    await writeFile(file, `# Guide\n\nssh ${REAL}\n\nSee [notes](private/server-notes.md).\n`);
    const uri = vscode.Uri.file(file);
    await eventually(() => vscode.languages.getDiagnostics(uri).length === 2, 10_000);
    const [value, link] = vscode.languages.getDiagnostics(uri);
    assert.equal(value?.severity, vscode.DiagnosticSeverity.Error);
    assert.match(value?.message ?? "", /myhost/);
    assert.equal(value?.range.start.line, 2);
    assert.equal(value?.range.start.character, 4);
    assert.equal(link?.code, "links-private");
    for (const d of vscode.languages.getDiagnostics(uri)) assert.ok(!d.message.includes(REAL));

    // Fixing the doc clears its problems.
    await writeFile(file, "# Guide\n\nssh myhost\n");
    await eventually(() => vscode.languages.getDiagnostics(uri).length === 0, 10_000);
  });

  it("holds back a typed hostname, then replaces it and syncs (REQ-13.3)", async () => {
    await writeFile(path.join(docs, "a.md"), "a\n");
    await eventually(async () => (await text(path.join(vaultFolder, "a.md"))) === "a\n", 5_000);
    await writeFile(path.join(vaultFolder, "a.md"), `ssh ${REAL}\n`);
    await eventually(
      () => docsApi.problems.problems.some((p) => p.fix === "replace-real-values"),
      5_000,
    );
    assert.equal(await text(path.join(docs, "a.md")), "a\n");
    const item = docsApi.problems.getChildren().find((i) => i.problem.path === "a.md");
    assert.equal(item?.contextValue, "projectDocs.problem.held-back.replace-real-values");
    assert.ok(!JSON.stringify(docsApi.problems.problems).includes(REAL));

    assert.equal(
      await vscode.commands.executeCommand("projectDocs.replaceRealValues", "a.md", {
        confirmed: true,
      }),
      true,
    );
    await eventually(async () => (await text(path.join(docs, "a.md"))) === "ssh myhost\n", 5_000);
    assert.equal(await text(path.join(vaultFolder, "a.md")), "ssh myhost\n");
    await eventually(() => docsApi.problems.problems.length === 0, 5_000);

    // Nothing the user can open shows the real value.
    await vscode.commands.executeCommand("projectDocs.showLog");
    assert.ok(!(vscode.window.activeTextEditor?.document.getText() ?? "").includes(REAL));
  });

  it("holds a note whose private marker was removed by hand until it's confirmed (REQ-10.4)", async () => {
    await writeFile(path.join(vaultFolder, "plan.md"), "---\nproject-docs: private\n---\nplan\n");
    await vscode.commands.executeCommand("projectDocs.syncNow");
    await writeFile(path.join(vaultFolder, "plan.md"), "plan\n");
    await eventually(() => docsApi.problems.problems.some((p) => p.kind === "was-private"), 5_000);
    const item = docsApi.problems.getChildren().find((i) => i.problem.path === "plan.md");
    assert.equal(item?.contextValue, "projectDocs.problem.was-private.confirm-syncable");
    assert.equal(await text(path.join(docs, "plan.md")), null);

    assert.equal(
      await vscode.commands.executeCommand("projectDocs.confirmSyncable", item, {
        confirmed: true,
      }),
      true,
    );
    await eventually(async () => (await text(path.join(docs, "plan.md"))) === "plan\n", 5_000);
    await eventually(() => docsApi.problems.problems.length === 0, 5_000);
  });
});
