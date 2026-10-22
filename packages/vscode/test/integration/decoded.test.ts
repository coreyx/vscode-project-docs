/**
 * Integration tests of decoded views (REQ-14, REQ-15.0.5): real values shown read-only, with the
 * mode always visible, and nothing decoded without a usable PRIVATE.md.
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
const SCHEME = "project-docs-decoded";

async function eventually(check: () => Promise<boolean> | boolean, ms: number): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < ms) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`not within ${ms} ms`);
}

describe("the decoded toggle (REQ-15.3)", () => {
  it("sits in the editor title, visible without opening a menu", () => {
    const manifest = vscode.extensions.getExtension(ID)?.packageJSON as {
      contributes: { menus: Record<string, { command?: string; group?: string }[]> };
    };
    const entry = manifest.contributes.menus["editor/title"]?.find(
      (m) => m.command === "projectDocs.showDecoded",
    );
    assert.equal(entry?.group, "navigation");
  });
});

describe("decoded views", function () {
  this.timeout(60_000);
  let root: string;
  let repo: string;
  let file: string;
  let docsApi: ProjectDocsApi;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "pd-int-decoded-"));
    repo = path.join(root, "repo");
    const docs = path.join(repo, "docs");
    const vault = path.join(root, "Vault");
    await mkdir(docs, { recursive: true });
    await mkdir(vault, { recursive: true });
    spawnSync("git", ["init", "-q", repo]);
    await writeFile(
      path.join(repo, "PRIVATE.md"),
      `## Placeholders\n\n| \`myhost\` | \`${REAL}\` | host |\n`,
    );
    file = path.join(docs, "a.md");
    await writeFile(file, "ssh myhost\n");
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

  it("shows real values read-only, says so, and leaves the file alone (REQ-14.2)", async () => {
    await vscode.window.showTextDocument(vscode.Uri.file(file));
    await eventually(() => docsApi.decoded.modeText === "$(lock) Coded", 5_000);

    await vscode.commands.executeCommand("projectDocs.showDecoded");
    const editor = vscode.window.activeTextEditor;
    assert.equal(editor?.document.uri.scheme, SCHEME);
    assert.equal(editor.document.getText(), `ssh ${REAL}\n`);
    assert.equal(editor.document.languageId, "markdown");
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    assert.ok(tab?.label.endsWith("(Decoded: real values shown)"));
    await eventually(() => docsApi.decoded.modeText === "$(eye) Decoded: real values shown", 5_000);

    // Typing is impossible, and so is any edit through the API.
    await vscode.commands.executeCommand("type", { text: "typed " });
    assert.equal(editor.document.getText(), `ssh ${REAL}\n`, "typing");
    const edited = await editor.edit((b) => b.insert(new vscode.Position(0, 0), "typed "));
    assert.equal(editor.document.getText(), `ssh ${REAL}\n`, `editor.edit returned ${edited}`);
    assert.equal(editor.document.isDirty, false);
    // Nothing can write the decoded text anywhere: the file system refuses (REQ-14.0.3).
    await assert.rejects(
      Promise.resolve(vscode.workspace.fs.writeFile(editor.document.uri, Buffer.from("x"))),
    );
    assert.equal(await readFile(file, "utf8"), "ssh myhost\n");

    // The toggle goes back to the coded file.
    await vscode.commands.executeCommand("projectDocs.toggleDecoded");
    assert.equal(vscode.window.activeTextEditor?.document.uri.fsPath, vscode.Uri.file(file).fsPath);
  });

  it("follows edits to the coded file", async () => {
    await vscode.window.showTextDocument(vscode.Uri.file(file));
    await vscode.commands.executeCommand("projectDocs.showDecoded");
    const decoded = vscode.window.activeTextEditor?.document;
    await writeFile(file, "ssh myhost again\n");
    await eventually(() => decoded?.getText() === `ssh ${REAL} again\n`, 5_000);
  });

  it("decodes nothing without PRIVATE.md, and shows the standard's error (REQ-14.4)", async () => {
    await vscode.window.showTextDocument(vscode.Uri.file(file));
    await vscode.commands.executeCommand("projectDocs.showDecoded");
    const open = vscode.window.activeTextEditor?.document;
    await rm(path.join(repo, "PRIVATE.md"));
    // An open decoded view stops showing real values.
    await eventually(() => open?.getText().startsWith("Nothing is decoded") === true, 5_000);
    assert.ok(!open?.getText().includes(REAL));

    await vscode.window.showTextDocument(vscode.Uri.file(file));
    const result = (await vscode.commands.executeCommand("projectDocs.showDecoded")) as {
      error?: string;
    };
    assert.match(result.error ?? "", /restore it from wherever you keep it/);
    assert.equal(vscode.window.activeTextEditor?.document.uri.scheme, "file");
    await eventually(() => docsApi.decoded.modeText === undefined, 5_000);
  });

  it("opens a decoded Markdown preview", async () => {
    await vscode.window.showTextDocument(vscode.Uri.file(file));
    await vscode.commands.executeCommand("projectDocs.openDecodedPreview");
    await eventually(
      () =>
        vscode.window.tabGroups.all.some((g) =>
          g.tabs.some((t) => t.label.includes("Preview") && t.label.includes("Decoded")),
        ),
      5_000,
    );
  });
});
