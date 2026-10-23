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

  describe("deep links (REQ-2.6, 2.7, 2.11, 2.12)", () => {
    const note = () => path.join(vault, "Projects", "repo", "repo.md");
    const file = () => path.join(repo, ".project-docs.json");
    const byPath = () => `obsidian://open?path=${encodeURIComponent(note())}`;
    const committed = async () =>
      JSON.parse(await readFile(file(), "utf8")) as {
        projectId: string;
        settings: Record<string, unknown>;
        deepLink?: string;
      };
    /** Edits the committed setting by hand, as a person or a teammate's commit would. */
    const setByHand = async (on: boolean, deepLink?: string) => {
      const record = await committed();
      record.settings.advancedUriDeepLinks = on;
      if (deepLink) record.deepLink = deepLink;
      else delete record.deepLink;
      await writeFile(file(), JSON.stringify(record, null, 2));
    };

    it("opens by path while the setting is off, with no uid written (REQ-2.7)", async () => {
      assert.equal(await docsApi.obsidian.uri(), byPath());
      assert.doesNotMatch(await readFile(note(), "utf8"), /^uid:/m);
    });

    it("changes nothing when the offer's list of changes is cancelled, and both when confirmed (REQ-2.11)", async () => {
      await mkdir(path.join(vault, ".obsidian", "plugins", "obsidian-advanced-uri"), {
        recursive: true,
      });
      const [recordBefore, noteBefore] = [
        await readFile(file(), "utf8"),
        await readFile(note(), "utf8"),
      ];
      await docsApi.obsidian.reconcile({ offer: "turnOn", changes: "cancel" });
      assert.equal(await readFile(file(), "utf8"), recordBefore);
      assert.equal(await readFile(note(), "utf8"), noteBefore);
      assert.equal(await docsApi.obsidian.uri(), byPath());

      await docsApi.obsidian.reconcile({ offer: "turnOn", changes: "confirm" });
      const { projectId, deepLink } = await committed();
      assert.equal(deepLink, `obsidian://adv-uri?uid=${projectId}`);
      assert.ok(!(await readFile(file(), "utf8")).includes("Vault"));
      assert.match(await readFile(note(), "utf8"), new RegExp(`^uid: ${projectId}$`, "m"));
      assert.equal(await docsApi.obsidian.uri(), deepLink);
    });

    it("turns a setting switched on by hand back off when its changes are cancelled", async () => {
      await setByHand(true);
      await docsApi.obsidian.reconcile({ changes: "cancel" });
      const record = await committed();
      assert.equal(record.settings.advancedUriDeepLinks, false);
      assert.equal(record.deepLink, undefined);
      assert.doesNotMatch(await readFile(note(), "utf8"), /^uid:/m);

      await setByHand(true);
      await docsApi.obsidian.reconcile({ changes: "confirm" });
      assert.equal(await docsApi.obsidian.uri(), `obsidian://adv-uri?uid=${record.projectId}`);
    });

    it("asks before adding the uid a teammate's setting needs, and opens by path until then (REQ-2.12)", async () => {
      const { projectId } = await committed();
      await setByHand(true, `obsidian://adv-uri?uid=${projectId}`);
      const noteBefore = await readFile(note(), "utf8");
      assert.equal(await docsApi.obsidian.uri(), byPath());

      await docsApi.obsidian.reconcile({ uid: "notNow" });
      assert.equal(await readFile(note(), "utf8"), noteBefore);
      // Answered once, it isn't asked again.
      await docsApi.obsidian.reconcile();
      assert.equal(await readFile(note(), "utf8"), noteBefore);
      assert.equal(await docsApi.obsidian.uri(), byPath());

      await docsApi.obsidian.reconcile({ uid: "add" });
      assert.match(await readFile(note(), "utf8"), new RegExp(`^uid: ${projectId}$`, "m"));
      assert.equal(await docsApi.obsidian.uri(), `obsidian://adv-uri?uid=${projectId}`);
    });

    it("removes the deep link when the setting is turned off, and leaves the uid", async () => {
      await setByHand(true);
      await docsApi.obsidian.reconcile({ changes: "confirm" });
      const { projectId } = await committed();
      const deepLink = `obsidian://adv-uri?uid=${projectId}`;
      await setByHand(false, deepLink);
      await docsApi.obsidian.reconcile();
      assert.equal((await committed()).deepLink, undefined);
      assert.match(await readFile(note(), "utf8"), new RegExp(`^uid: ${projectId}$`, "m"));
      assert.equal(await docsApi.obsidian.uri(), byPath());
    });
  });
});
