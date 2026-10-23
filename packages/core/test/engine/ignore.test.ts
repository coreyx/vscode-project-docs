import { afterEach, describe, expect, it } from "vitest";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { syncOnce, type Project } from "../../src/engine/index.js";
import { parseStatusFile, statusFilePath } from "../../src/status/index.js";
import { linkedProject, type LinkedProject, type LinkOptions } from "../watch/project.js";

let linked: LinkedProject | undefined;
afterEach(async () => {
  await linked?.cleanup();
  linked = undefined;
});

const read = (file: string) => readFile(file, "utf8").catch(() => null);

/** Links a project and opens it. */
async function link(options: LinkOptions): Promise<{ linked: LinkedProject; project: Project }> {
  linked = await linkedProject(undefined, options);
  return { linked, project: await linked.open() };
}

/** Writes files under `root`, creating folders as needed. */
async function files(root: string, entries: Record<string, string>): Promise<void> {
  for (const [key, text] of Object.entries(entries)) {
    const file = path.join(root, ...key.split("/"));
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, text);
  }
}

/** The repo-side layout every test starts from: a root link's worth of junk and one real doc. */
const REPO_FILES = {
  ".gitignore": "build/\nscratch/\n",
  "README.md": "# Readme\n",
  "node_modules/pkg/README.md": "# A package\n",
  "node_modules/pkg/index.js": "module.exports = 1;\n",
  "build/notes.md": "# Built\n",
  "build/out.js": "built();\n",
};

describe("linking the repo root (REQ-3.0.7, AC 3.6)", () => {
  it("leaves node_modules and git-ignored folders out of the vault, and ignored vault notes out of the repo", async () => {
    const { linked, project } = await link({ docsFolder: "" });
    await files(linked.repo, REPO_FILES);
    await files(linked.vaultFolder, { "build/from-vault.md": "vault\n", "plan.md": "plan\n" });
    const outcome = await syncOnce(project);
    expect(outcome.outcome).toBe("synced");

    expect(await read(path.join(linked.vaultFolder, "README.md"))).toBe("# Readme\n");
    expect(
      await read(path.join(linked.vaultFolder, "node_modules", "pkg", "README.md")),
    ).toBeNull();
    expect(await read(path.join(linked.vaultFolder, "build", "notes.md"))).toBeNull();
    expect(await read(path.join(linked.repo, "plan.md"))).toBe("plan\n");
    expect(await read(path.join(linked.repo, "build", "from-vault.md"))).toBeNull();
    // Both copies of an ignored path stay where they are.
    expect(await read(path.join(linked.vaultFolder, "build", "from-vault.md"))).toBe("vault\n");
    expect(await read(path.join(linked.repo, "build", "notes.md"))).toBe("# Built\n");
  });

  it("copies no ignored file with attachment sync on, but does copy other attachments", async () => {
    const { linked, project } = await link({
      docsFolder: "",
      settings: { syncAttachments: true },
    });
    await files(linked.repo, { ...REPO_FILES, "diagram.svg": "<svg/>\n" });
    await syncOnce(project);
    expect(await read(path.join(linked.vaultFolder, "diagram.svg"))).toBe("<svg/>\n");
    expect(await read(path.join(linked.vaultFolder, "node_modules", "pkg", "index.js"))).toBeNull();
    expect(await read(path.join(linked.vaultFolder, "build", "out.js"))).toBeNull();
  });

  it("leaves node_modules out of a repo with no .gitignore", async () => {
    const { linked, project } = await link({ docsFolder: "" });
    await files(linked.repo, { "node_modules/pkg/README.md": "# A package\n" });
    await syncOnce(project);
    expect(
      await read(path.join(linked.vaultFolder, "node_modules", "pkg", "README.md")),
    ).toBeNull();
  });
});

describe("syncIgnored (AC 3.9)", () => {
  it("syncs a git-ignored folder it lists both ways, but never node_modules", async () => {
    const { linked, project } = await link({
      docsFolder: "",
      settings: { syncIgnored: ["/scratch/", "/node_modules/"] },
    });
    await files(linked.repo, { ...REPO_FILES, "scratch/idea.md": "idea\n" });
    await syncOnce(project);
    expect(await read(path.join(linked.vaultFolder, "scratch", "idea.md"))).toBe("idea\n");
    expect(
      await read(path.join(linked.vaultFolder, "node_modules", "pkg", "README.md")),
    ).toBeNull();

    await writeFile(path.join(linked.vaultFolder, "scratch", "idea.md"), "idea, edited\n");
    await syncOnce(project);
    expect(await read(path.join(linked.repo, "scratch", "idea.md"))).toBe("idea, edited\n");
  });
});

describe("a .gitignore that can't be read (REQ-3.0.9, AC 3.8)", () => {
  it("stops the pass, and status.json names the file", async () => {
    const { linked, project } = await link({});
    await files(linked.docs, { "guide.md": "guide\n" });
    // A folder can't be read as a file, on every platform.
    await mkdir(path.join(linked.docs, "sub", ".gitignore"), { recursive: true });
    const outcome = await syncOnce(project);
    expect(outcome.outcome === "synced" && outcome.plan.actions).toEqual([]);
    expect(await read(path.join(linked.vaultFolder, "guide.md"))).toBeNull();
    const status = parseStatusFile(await read(statusFilePath(linked.vaultFolder)));
    expect(status?.items).toMatchObject([
      { kind: "ignore-rules-unreadable", path: "sub/.gitignore" },
    ]);
    expect(status?.items[0]?.message).toContain("docs/sub/.gitignore");
  });
});

describe("a synced note whose folder becomes ignored (REQ-3.0.8)", () => {
  it("stops syncing, and neither copy is deleted or moved to the trash", async () => {
    const { linked, project } = await link({});
    await files(linked.docs, { "drafts/a.md": "a\n" });
    await syncOnce(project);
    expect(await read(path.join(linked.vaultFolder, "drafts", "a.md"))).toBe("a\n");

    await writeFile(path.join(linked.repo, ".gitignore"), "drafts/\n");
    await writeFile(path.join(linked.vaultFolder, "drafts", "a.md"), "a, edited in the vault\n");
    await syncOnce(project);
    expect(await read(path.join(linked.docs, "drafts", "a.md"))).toBe("a\n");
    expect(await read(path.join(linked.vaultFolder, "drafts", "a.md"))).toBe(
      "a, edited in the vault\n",
    );
  });
});
