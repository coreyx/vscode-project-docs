/**
 * Integration tests of linking inside VS Code (REQ-1): the commands are registered, and linking
 * through the extension creates the records and runs the first sync.
 */
import * as assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import type { ProjectDocsApi } from "../../src/extension.js";
import type { Prompter } from "../../src/link/flow.js";

const ID = "specdevship.project-docs";

async function api(): Promise<ProjectDocsApi> {
  const extension = vscode.extensions.getExtension<ProjectDocsApi>(ID);
  assert.ok(extension);
  return extension.activate();
}

describe("linking", () => {
  let root: string;
  let repo: string;
  let vault: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "pd-int-link-"));
    repo = path.join(root, "repo");
    vault = path.join(root, "Vault");
    await mkdir(path.join(repo, "docs"), { recursive: true });
    await mkdir(vault, { recursive: true });
    spawnSync("git", ["init", "-q", repo]);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("registers the link commands", async () => {
    await api();
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes("projectDocs.link"));
    assert.ok(commands.includes("projectDocs.unlink"));
  });

  it("links in three prompts and runs the first sync (REQ-1.1)", async () => {
    await writeFile(path.join(repo, "docs", "guide.md"), "# Guide\n");
    let prompts = 0;
    const prompter: Prompter = {
      docsFolder: async (value) => (prompts++, value),
      vault: async () => (prompts++, vault),
      vaultFolder: async (value) => (prompts++, value),
    };
    const result = await (await api()).link(repo, prompter);
    assert.deepEqual(result, { outcome: "linked", repoRoot: repo });
    assert.ok(prompts <= 4, `${prompts} prompts`);
    const synced = await readFile(path.join(vault, "Projects", "repo", "docs", "guide.md"), "utf8");
    assert.equal(synced.replace(/\r\n/g, "\n"), "# Guide\n");
  });

  for (const keep of [true, false]) {
    const what = keep ? "syncs a git-ignored folder of notes picked" : "leaves out one not picked";
    it(`${what} when linking (AC 1.6)`, async () => {
      await writeFile(path.join(repo, ".gitignore"), "scratch/\n");
      await mkdir(path.join(repo, "docs", "scratch"), { recursive: true });
      await writeFile(path.join(repo, "docs", "scratch", "idea.md"), "idea\n");
      await writeFile(path.join(repo, "docs", "guide.md"), "# Guide\n");
      const offered: string[] = [];
      const prompter: Prompter = {
        docsFolder: async (value) => value,
        vault: async () => vault,
        vaultFolder: async (value) => value,
        ignoredFolders: async (folders) => (offered.push(...folders), keep ? [...folders] : []),
      };
      const docs = await api();
      await docs.link(repo, prompter);
      assert.deepEqual(offered, ["docs/scratch"]);
      const read = (key: string) =>
        readFile(path.join(vault, "Projects", "repo", ...key.split("/")), "utf8").then(
          (t) => t.replace(/\r\n/g, "\n"),
          () => null,
        );
      assert.equal(await read("docs/guide.md"), "# Guide\n");
      assert.equal(await read("docs/scratch/idea.md"), keep ? "idea\n" : null);
      await docs.unlink(repo);
    });
  }

  it("unlinks, leaving every file in place (REQ-1.5)", async () => {
    const prompter: Prompter = {
      docsFolder: async (value) => value,
      vault: async () => vault,
      vaultFolder: async (value) => value,
    };
    const docs = await api();
    await docs.link(repo, prompter);
    await writeFile(path.join(repo, "docs", "kept.md"), "kept\n");
    assert.equal(await docs.unlink(repo), true);
    assert.equal(await readFile(path.join(repo, "docs", "kept.md"), "utf8"), "kept\n");
    await assert.rejects(readFile(path.join(repo, ".project-docs.json")));
  });
});
