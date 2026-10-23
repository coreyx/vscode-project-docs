import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  findIgnoredNoteFolders,
  inNodeModules,
  loadIgnoreRules,
  type IgnoreRules,
} from "../../src/scan/index.js";

let repo: string;
beforeEach(async () => {
  repo = await mkdtemp(path.join(tmpdir(), "pd-ignore-"));
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

/** Writes files under the repo, creating folders as needed. */
async function files(entries: Record<string, string>): Promise<void> {
  for (const [key, text] of Object.entries(entries)) {
    const file = path.join(repo, ...key.split("/"));
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, text);
  }
}

/** Loads the rules, failing the test if a rule file couldn't be read. */
async function rules(docsFolder = "docs", syncIgnored: string[] = []): Promise<IgnoreRules> {
  const loaded = await loadIgnoreRules(repo, docsFolder, syncIgnored);
  if ("unreadable" in loaded) throw new Error(loaded.unreadable.message);
  return loaded.rules;
}

describe("loadIgnoreRules (REQ-3.0.7, design decision 20)", () => {
  it("applies .gitignore files above and inside the docs folder, by repo path", async () => {
    await files({
      ".gitignore": "build/\n*.log\n/docs/top-only.md\n",
      "docs/sub/.gitignore": "draft.md\n",
    });
    const r = await rules();
    expect(r.skips("build/notes.md", false)).toBe(true);
    expect(r.skips("build", true)).toBe(true);
    expect(r.skips("a/b/trace.log", false)).toBe(true);
    expect(r.skips("top-only.md", false)).toBe(true);
    expect(r.skips("sub/top-only.md", false)).toBe(false);
    expect(r.skips("sub/draft.md", false)).toBe(true);
    // A nested .gitignore applies only below its own folder.
    expect(r.skips("draft.md", false)).toBe(false);
    expect(r.skips("guide.md", false)).toBe(false);
  });

  it("lets a deeper .gitignore re-include what a shallower one ignores, as git does", async () => {
    await files({ ".gitignore": "*.tmp.md\n", "docs/keep/.gitignore": "!*.tmp.md\n" });
    const r = await rules();
    expect(r.skips("a.tmp.md", false)).toBe(true);
    expect(r.skips("keep/a.tmp.md", false)).toBe(false);
  });

  it("can't bring back a file inside an ignored folder with a negation", async () => {
    await files({ "docs/.gitignore": "scratch/\n!scratch/a.md\n" });
    expect((await rules()).skips("scratch/a.md", false)).toBe(true);
  });

  it("reads .git/info/exclude, and finds it through a worktree's .git file", async () => {
    await files({ ".git/info/exclude": "secret/\n" });
    expect((await rules()).skips("secret/x.md", false)).toBe(true);

    const main = path.join(repo, "main-git");
    await files({
      "main-git/info/exclude": "other/\n",
      "main-git/worktrees/wt/commondir": "../..\n",
    });
    await rm(path.join(repo, ".git"), { recursive: true });
    await writeFile(path.join(repo, ".git"), `gitdir: ${path.join(main, "worktrees", "wt")}\n`);
    const r = await rules();
    expect(r.skips("other/x.md", false)).toBe(true);
    expect(r.skips("secret/x.md", false)).toBe(false);
  });

  it("always skips node_modules, even with no .gitignore and when syncIgnored lists it", async () => {
    const r = await rules("", ["/node_modules/", "node_modules"]);
    expect(r.skips("node_modules/pkg/README.md", false)).toBe(true);
    expect(r.skips("a/node_modules", true)).toBe(true);
    expect(r.skipsFolder("node_modules")).toBe(true);
    expect(inNodeModules("a/node_modules/b.md")).toBe(true);
    expect(inNodeModules("node_modules_notes.md")).toBe(false);
  });

  it("syncs what syncIgnored lists although git ignores it", async () => {
    await files({ ".gitignore": "scratch/\nbuild/\n" });
    const r = await rules("", ["/scratch/"]);
    expect(r.gitIgnores("scratch/a.md", false)).toBe(true);
    expect(r.skips("scratch/a.md", false)).toBe(false);
    expect(r.skips("scratch", true)).toBe(false);
    expect(r.skips("build/a.md", false)).toBe(true);
  });

  it("judges a path that exists on neither side, as for a vault-only note", async () => {
    await files({ ".gitignore": "drafts/\n" });
    expect((await rules("")).skips("drafts/never-in-repo.md", false)).toBe(true);
  });

  it("skips an ignored folder whole, unless an exception might be inside it", async () => {
    await files({ ".gitignore": "build/\nscratch/\n" });
    expect((await rules("", ["/scratch/"])).skipsFolder("build")).toBe(true);
    const anchored = await rules("", ["/build/notes/"]);
    expect(anchored.skipsFolder("build")).toBe(false);
    expect(anchored.skips("build/out.md", false)).toBe(true);
    expect(anchored.skips("build/notes/a.md", false)).toBe(false);
    // A pattern without a slash could match at any depth, so nothing ignored is skipped whole.
    expect((await rules("", ["notes.md"])).skipsFolder("build")).toBe(false);
  });

  it("doesn't read .gitignore files inside ignored folders", async () => {
    // A folder named .gitignore can't be read as a file, so reading it would fail the load.
    await files({ ".gitignore": "build/\n" });
    await mkdir(path.join(repo, "build", ".gitignore"), { recursive: true });
    await mkdir(path.join(repo, "node_modules", "pkg", ".gitignore"), { recursive: true });
    expect((await rules("")).skips("build/a.md", false)).toBe(true);
  });

  it("reports a rule file that can't be read, by its repo path", async () => {
    await mkdir(path.join(repo, "docs", "sub", ".gitignore"), { recursive: true });
    const loaded = await loadIgnoreRules(repo, "docs", []);
    expect(loaded).toMatchObject({ unreadable: { file: "docs/sub/.gitignore" } });
    expect("unreadable" in loaded && loaded.unreadable.message).toContain("isn't syncing");
  });
});

describe("findIgnoredNoteFolders (REQ-1.0.6)", () => {
  it("lists the outermost ignored folders that hold notes, but not node_modules", async () => {
    await files({
      ".gitignore": "scratch/\nbuild/\nprivate-drafts/\n",
      "docs/scratch/deep/a.md": "a\n",
      "docs/build/out.js": "built();\n",
      "docs/notes/guide.md": "guide\n",
      "docs/notes/private-drafts/b.md": "b\n",
      "docs/node_modules/pkg/README.md": "pkg\n",
    });
    expect(await findIgnoredNoteFolders(repo, "docs")).toEqual(["notes/private-drafts", "scratch"]);
  });

  it("finds none when the rules can't be read", async () => {
    await files({ "docs/scratch/a.md": "a\n" });
    await mkdir(path.join(repo, ".gitignore"));
    expect(await findIgnoredNoteFolders(repo, "docs")).toEqual([]);
  });
});
