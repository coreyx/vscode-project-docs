/**
 * Integration tests of PRIVATE.md setup and the walkthrough (REQ-15), and of the links between
 * the repo and Obsidian (REQ-2.4, 2.6, 2.7).
 */
import * as assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
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

describe("the walkthrough (REQ-15.1)", () => {
  it("covers linking and PRIVATE.md, with every page it shows", () => {
    const extension = vscode.extensions.getExtension(ID);
    const manifest = extension?.packageJSON as {
      contributes: {
        walkthroughs: { id: string; steps: { id: string; media: { markdown: string } }[] }[];
      };
    };
    const [walkthrough] = manifest.contributes.walkthroughs;
    assert.equal(walkthrough?.id, "gettingStarted");
    const steps = walkthrough?.steps ?? [];
    assert.ok(steps.some((s) => s.id === "link"));
    assert.ok(steps.some((s) => s.id === "privateMd"));
    for (const step of steps) {
      assert.ok(existsSync(path.join(extension?.extensionPath ?? "", step.media.markdown)));
    }
  });
});

describe("PRIVATE.md setup and Obsidian links", function () {
  this.timeout(60_000);
  let root: string;
  let repo: string;
  let vault: string;
  let docsApi: ProjectDocsApi;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "pd-int-setup-"));
    repo = path.join(root, "repo");
    vault = path.join(root, "Vault");
    await mkdir(path.join(repo, "docs"), { recursive: true });
    await mkdir(vault, { recursive: true });
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
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });

  it("creates both files and the .gitignore entries, and git sees only the example (REQ-15.2)", async () => {
    assert.equal(await vscode.commands.executeCommand("projectDocs.setupPrivateMd"), "created");
    assert.match(await readFile(path.join(repo, "PRIVATE.md"), "utf8"), /## Placeholders/);
    assert.ok(existsSync(path.join(repo, "PRIVATE.example.md")));
    const ignore = (await readFile(path.join(repo, ".gitignore"), "utf8")).split(/\r?\n/);
    assert.ok(ignore.includes("PRIVATE.md") && ignore.includes("*.private.md"));
    const status = spawnSync("git", ["status", "--porcelain", "--untracked-files=all"], {
      cwd: repo,
      encoding: "utf8",
    }).stdout.split("\n");
    assert.ok(status.includes("?? PRIVATE.example.md"));
    assert.ok(!status.includes("?? PRIVATE.md"));
    // An empty table isn't a problem to report.
    await docsApi.controller()?.syncNow();
    assert.equal(docsApi.controller()?.state.state, "idle");
    // Running it again keeps the file as it is.
    assert.equal(await vscode.commands.executeCommand("projectDocs.setupPrivateMd"), "exists");
  });

  it("installs the standard's commit hooks with Python (REQ-15.0.4)", async function () {
    await docsApi.privateMd.setup();
    const result = await docsApi.privateMd.install();
    if (result?.outcome === "no-python") this.skip();
    assert.equal(result?.outcome, "installed");
    assert.ok(existsSync(path.join(repo, ".githooks", "pre-commit")));
    assert.ok(existsSync(path.join(repo, "scripts", "check-private.py")));
    const hooksPath = spawnSync("git", ["config", "core.hooksPath"], {
      cwd: repo,
      encoding: "utf8",
    });
    assert.equal(hooksPath.stdout.trim(), ".githooks");
  });

  it("puts a link that opens this repo in VS Code in the folder note (REQ-2.4)", async () => {
    const note = await readFile(path.join(vault, "Projects", "repo", "repo.md"), "utf8");
    const link = /\[Open the repo in VS Code\]\((vscode:\/\/[^)]+)\)/.exec(note)?.[1];
    assert.ok(link);
    const target = vscode.Uri.parse(link);
    assert.equal(target.authority, "file");
    assert.equal(vscode.Uri.file(target.path).fsPath, vscode.Uri.file(repo).fsPath);
  });

  it("opens Obsidian by path, or by deep link once the setting is on (REQ-2.6, 2.7)", async () => {
    const note = path.join(vault, "Projects", "repo", "repo.md");
    assert.equal(await docsApi.obsidian.uri(), `obsidian://open?path=${encodeURIComponent(note)}`);
    assert.doesNotMatch(await readFile(note, "utf8"), /^uid:/m);

    // Turned on by hand in the committed file, the setting is applied on the next reconcile.
    const file = path.join(repo, ".project-docs.json");
    const committed = JSON.parse(await readFile(file, "utf8")) as {
      projectId: string;
      settings: Record<string, unknown>;
    };
    committed.settings.advancedUriDeepLinks = true;
    await writeFile(file, JSON.stringify(committed, null, 2));
    await docsApi.obsidian.reconcile();
    const deepLink = `obsidian://adv-uri?uid=${committed.projectId}`;
    assert.equal(await docsApi.obsidian.uri(), deepLink);
    const saved = await readFile(file, "utf8");
    assert.ok(saved.includes(deepLink));
    assert.ok(!saved.includes("Vault"));
    assert.match(await readFile(note, "utf8"), new RegExp(`^uid: ${committed.projectId}$`, "m"));
  });
});
