import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import * as path from "node:path";
import {
  ResolveError,
  conflictVersions,
  resolveConflict,
  syncOnce,
  versionText,
  type Project,
} from "../../src/engine/index.js";
import { linkedProject, type LinkedProject } from "../watch/project.js";

let linked: LinkedProject;
let project: Project;

beforeEach(async () => {
  linked = await linkedProject();
  project = await linked.open();
});
afterEach(async () => {
  await linked.cleanup();
});

async function makeConflict() {
  await writeFile(path.join(linked.docs, "a.md"), "line\n");
  await syncOnce(project);
  await writeFile(path.join(linked.docs, "a.md"), "repo line\n");
  await writeFile(path.join(linked.vaultFolder, "a.md"), "vault line\n");
  await syncOnce(project);
}

describe("conflict resolution (REQ-5.0.6)", () => {
  it("keeps all three versions for the merge editor (REQ-5.2)", async () => {
    await makeConflict();
    const versions = await conflictVersions(project, "a.md");
    expect(versions?.kind).toBe("markdown");
    expect(versionText(versions?.base ?? null)).toBe("line\n");
    expect(versionText(versions?.repo ?? null)).toBe("repo line\n");
    expect(versionText(versions?.vault ?? null)).toBe("vault line\n");
    expect(await conflictVersions(project, "nothing.md")).toBeNull();
  });

  it("writes the resolution to both sides, after which edits sync normally (REQ-5.3)", async () => {
    await makeConflict();
    await resolveConflict(project, "a.md", "merged by hand\n");
    const read = (file: string) => readFile(file, "utf8").then((t) => t.replace(/\r\n/g, "\n"));
    expect(await read(path.join(linked.docs, "a.md"))).toBe("merged by hand\n");
    expect(await read(path.join(linked.vaultFolder, "a.md"))).toBe("merged by hand\n");
    expect(await project.store.listConflicts()).toEqual([]);

    await writeFile(path.join(linked.vaultFolder, "a.md"), "merged by hand\nand edited later\n");
    await syncOnce(project);
    expect(await read(path.join(linked.docs, "a.md"))).toBe("merged by hand\nand edited later\n");
  });

  it("resolves an attachment conflict with the chosen bytes", async () => {
    await writeFile(path.join(linked.docs, "a.md"), "x\n");
    await syncOnce(project);
    const { index } = await project.store.loadIndex();
    await project.store.saveIndex({
      ...index,
      entries: { ...index.entries, "a.md": { ...index.entries["a.md"]!, state: "conflict" } },
    });
    await resolveConflict(project, "a.md", new Uint8Array([104, 105]));
    expect(await readFile(path.join(linked.vaultFolder, "a.md"), "utf8")).toBe("hi");
  });

  it("refuses to resolve a file that has no conflict", async () => {
    await writeFile(path.join(linked.docs, "b.md"), "b\n");
    await syncOnce(project);
    await expect(resolveConflict(project, "b.md", "x")).rejects.toBeInstanceOf(ResolveError);
  });
});
