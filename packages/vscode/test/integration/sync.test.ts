/**
 * Integration tests of watching and syncing inside VS Code (REQ-3.1, REQ-20.2): changes made outside
 * VS Code (as Obsidian would make them) and inside it both reach the other side quickly, and an idle
 * linked project costs no noticeable CPU.
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

async function eventually(check: () => Promise<boolean>, ms: number): Promise<number> {
  const started = Date.now();
  while (Date.now() - started < ms) {
    if (await check()) return Date.now() - started;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`not within ${ms} ms`);
}

const fileIs = (file: string, text: string) => async () => {
  try {
    return (await readFile(file, "utf8")).replace(/\r\n/g, "\n") === text;
  } catch {
    return false;
  }
};

describe("syncing while VS Code is open", function () {
  this.timeout(180_000);
  let root: string;
  let repo: string;
  let docs: string;
  let vaultFolder: string;
  let docsApi: ProjectDocsApi;

  before(async () => {
    root = await mkdtemp(path.join(tmpdir(), "pd-int-sync-"));
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
    await eventually(async () => docsApi.controller()?.state.state === "idle", 10_000);
  });

  after(async () => {
    await docsApi.unlink(repo);
    await rm(root, { recursive: true, force: true });
  });

  it("brings an edit made in the vault to the repo within 2 seconds (REQ-3.1)", async () => {
    await writeFile(path.join(vaultFolder, "from-obsidian.md"), "Written in Obsidian\n");
    const took = await eventually(
      fileIs(path.join(docs, "from-obsidian.md"), "Written in Obsidian\n"),
      5_000,
    );
    assert.ok(took < 2_000, `took ${took} ms`);
  });

  it("brings an edit made in the repo to the vault within 2 seconds (REQ-3.1)", async () => {
    await writeFile(path.join(docs, "from-vscode.md"), "Written in VS Code\n");
    const took = await eventually(
      fileIs(path.join(vaultFolder, "from-vscode.md"), "Written in VS Code\n"),
      5_000,
    );
    assert.ok(took < 2_000, `took ${took} ms`);
  });

  it("stops syncing while paused, and catches up on resume (REQ-17.0.5)", async () => {
    await vscode.commands.executeCommand("projectDocs.pause");
    assert.equal(docsApi.controller()?.state.state, "paused");
    await writeFile(path.join(docs, "paused.md"), "while paused\n");
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    assert.equal(await fileIs(path.join(vaultFolder, "paused.md"), "while paused\n")(), false);
    await vscode.commands.executeCommand("projectDocs.resume");
    await eventually(fileIs(path.join(vaultFolder, "paused.md"), "while paused\n"), 5_000);
  });

  it("adds under 1% CPU while nothing changes (REQ-20.2)", async () => {
    // The extension host runs VS Code's own background work too, so measure it without a linked
    // project first, then with one idling, and hold Project Docs to the difference.
    const measure = async (ms: number) => {
      const start = process.cpuUsage();
      const startedAt = process.hrtime.bigint();
      await new Promise((resolve) => setTimeout(resolve, ms));
      const used = process.cpuUsage(start);
      return (used.user + used.system) / (Number(process.hrtime.bigint() - startedAt) / 1_000);
    };
    await docsApi.unlink(repo);
    const baseline = await measure(30_000);
    await docsApi.link(repo, {
      docsFolder: async (value) => value,
      vault: async () => path.dirname(path.dirname(vaultFolder)),
      vaultFolder: async (value) => value,
    });
    await eventually(async () => docsApi.controller()?.state.state === "idle", 10_000);
    const linked = await measure(60_000);
    const extra = linked - baseline;
    assert.ok(
      extra < 0.01,
      `Project Docs added ${(extra * 100).toFixed(2)}% CPU (baseline ${(baseline * 100).toFixed(2)}%)`,
    );
  });
});
