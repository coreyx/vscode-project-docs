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

describe("the vault mirrors the repo (REQ-22.0.1, design decisions 2 and 21)", () => {
  it("puts the docs at their repo path in the vault, both ways", async () => {
    const { linked, project } = await link();
    await files(linked.repo, { "docs/guide.md": "guide\n", "docs/deep/a.md": "a\n" });
    await syncOnce(project);
    expect(await read(path.join(linked.vaultFolder, "docs", "guide.md"))).toBe("guide\n");
    expect(await read(path.join(linked.vaultFolder, "docs", "deep", "a.md"))).toBe("a\n");

    await writeFile(path.join(linked.vaultFolder, "docs", "from-vault.md"), "vault\n");
    await syncOnce(project);
    expect(await read(path.join(linked.repo, "docs", "from-vault.md"))).toBe("vault\n");
  });

  it("leaves a vault note outside the docs folder in the vault, unreported (AC 22.4)", async () => {
    const { linked, project } = await link();
    await files(linked.vaultFolder, { "ideas.md": "ideas\n", "notes/todo.md": "todo\n" });
    await syncOnce(project);
    expect(await read(path.join(linked.repo, "ideas.md"))).toBeNull();
    expect(await read(path.join(linked.repo, "notes", "todo.md"))).toBeNull();
    expect(await read(path.join(linked.vaultFolder, "ideas.md"))).toBe("ideas\n");
    const status = parseStatusFile(await read(statusFilePath(linked.vaultFolder)));
    expect(status?.items ?? []).toEqual([]);
  });

  it("leaves out the rest of the repo (AC 22.6)", async () => {
    const { linked, project } = await link({ settings: { syncAttachments: true } });
    await files(linked.repo, {
      "src/notes.md": "notes\n",
      "src/index.ts": "export {};\n",
      "CONTRIBUTING.md": "contributing\n",
      "docs/guide.md": "guide\n",
    });
    await syncOnce(project);
    expect(await read(path.join(linked.vaultFolder, "docs", "guide.md"))).toBe("guide\n");
    expect(await read(path.join(linked.vaultFolder, "src", "notes.md"))).toBeNull();
    expect(await read(path.join(linked.vaultFolder, "src", "index.ts"))).toBeNull();
    expect(await read(path.join(linked.vaultFolder, "CONTRIBUTING.md"))).toBeNull();
  });

  it("keeps the private folder inside the docs folder (design decision 21)", async () => {
    const { linked, project } = await link();
    await files(linked.vaultFolder, { "docs/private/secret.md": "secret\n" });
    await syncOnce(project);
    expect(await read(path.join(linked.repo, "docs", "private", "secret.md"))).toBeNull();
  });

  it("is the same as before for a repo-root link (AC 22.7)", async () => {
    const { linked, project } = await link({ docsFolder: "" });
    await files(linked.repo, { "guide.md": "guide\n", "src/notes.md": "notes\n" });
    await syncOnce(project);
    expect(await read(path.join(linked.vaultFolder, "guide.md"))).toBe("guide\n");
    expect(await read(path.join(linked.vaultFolder, "src", "notes.md"))).toBe("notes\n");
  });
});
