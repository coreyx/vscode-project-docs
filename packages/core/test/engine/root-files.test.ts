import { afterEach, describe, expect, it } from "vitest";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { syncOnce, type Project } from "../../src/engine/index.js";
import { linkedProject, type LinkedProject, type LinkOptions } from "../watch/project.js";

let linked: LinkedProject | undefined;
afterEach(async () => {
  await linked?.cleanup();
  linked = undefined;
});

const read = (file: string) => readFile(file, "utf8").catch(() => null);

/** Links a project and opens it. */
async function link(
  options: LinkOptions = {},
): Promise<{ linked: LinkedProject; project: Project }> {
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

/** Rewrites the committed link file's `rootFiles`, as a hand edit or a teammate's pull would. */
async function setRootFiles(repo: string, rootFiles: string[]): Promise<void> {
  const file = path.join(repo, ".project-docs.json");
  const committed = JSON.parse((await read(file)) ?? "{}");
  committed.settings.rootFiles = rootFiles;
  await writeFile(file, `${JSON.stringify(committed, null, 2)}\n`);
}

const ROOT_FILES = {
  "README.md": "# Readme\n",
  "CHANGELOG.md": "# Changelog\n",
  "RELEASE_NOTES.md": "# Release notes\n",
};

describe("root files (REQ-22.0.2, AC 22.1)", () => {
  it("sync the default three at the top of the vault folder, both ways", async () => {
    const { linked, project } = await link();
    await files(linked.repo, { ...ROOT_FILES, "docs/guide.md": "guide\n" });
    await syncOnce(project);
    for (const [name, text] of Object.entries(ROOT_FILES)) {
      expect(await read(path.join(linked.vaultFolder, name))).toBe(text);
    }
    expect(await read(path.join(linked.vaultFolder, "docs", "guide.md"))).toBe("guide\n");

    await writeFile(path.join(linked.vaultFolder, "README.md"), "# Readme, edited in Obsidian\n");
    await syncOnce(project);
    expect(await read(path.join(linked.repo, "README.md"))).toBe("# Readme, edited in Obsidian\n");
  });

  it("link to the docs, and the docs to them, by the same paths on both sides (AC 22.2)", async () => {
    const { linked, project } = await link();
    await files(linked.repo, { "README.md": "# Readme\n", "docs/guide.md": "guide\n" });
    // Enough other docs that two edits at once stay under the bulk guard's threshold.
    for (let i = 0; i < 10; i++) await files(linked.repo, { [`docs/more-${i}.md`]: `${i}\n` });
    await syncOnce(project);
    await writeFile(
      path.join(linked.vaultFolder, "README.md"),
      "# Readme\n\nSee [[docs/guide]].\n",
    );
    await writeFile(
      path.join(linked.vaultFolder, "docs", "guide.md"),
      "guide\n\nBack to [[README]].\n",
    );
    await syncOnce(project);
    expect(await read(path.join(linked.repo, "README.md"))).toContain("(docs/guide.md)");
    expect(await read(path.join(linked.repo, "docs", "guide.md"))).toContain("(../README.md)");
  });

  it("don't sync with rootFiles set to [] (AC 22.3)", async () => {
    const { linked, project } = await link({ settings: { rootFiles: [] } });
    await files(linked.repo, ROOT_FILES);
    await files(linked.vaultFolder, { "README.md": "# From Obsidian\n" });
    await syncOnce(project);
    expect(await read(path.join(linked.vaultFolder, "CHANGELOG.md"))).toBeNull();
    expect(await read(path.join(linked.repo, "README.md"))).toBe("# Readme\n");
  });

  it("stop syncing when a name is removed, leaving both copies (REQ-22.0.4, AC 22.3)", async () => {
    const { linked, project } = await link();
    await files(linked.repo, ROOT_FILES);
    await syncOnce(project);
    await setRootFiles(linked.repo, ["README.md", "RELEASE_NOTES.md"]);
    await syncOnce(project);
    expect(await read(path.join(linked.repo, "CHANGELOG.md"))).toBe("# Changelog\n");
    expect(await read(path.join(linked.vaultFolder, "CHANGELOG.md"))).toBe("# Changelog\n");

    await writeFile(path.join(linked.vaultFolder, "CHANGELOG.md"), "# Changelog, edited\n");
    await syncOnce(project);
    expect(await read(path.join(linked.repo, "CHANGELOG.md"))).toBe("# Changelog\n");
  });

  it("are held back like any doc, for a private marker and for a real value (AC 22.5)", async () => {
    const { linked, project } = await link();
    await writeFile(
      path.join(linked.repo, "PRIVATE.md"),
      "## Placeholders\n\n| `myhost` | `DESK-FAKE01` | host |\n",
    );
    await files(linked.vaultFolder, {
      "CHANGELOG.md": "---\nproject-docs: private\n---\nprivate changes\n",
      "README.md": "ssh DESK-FAKE01\n",
    });
    const outcome = await syncOnce(project);
    expect(await read(path.join(linked.repo, "CHANGELOG.md"))).toBeNull();
    expect(await read(path.join(linked.repo, "README.md"))).toBeNull();
    expect(outcome.outcome === "synced" && outcome.plan.notices).toContainEqual(
      expect.objectContaining({ key: "README.md", code: "held-back" }),
    );
  });
});
