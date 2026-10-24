import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { checkRepoDoc } from "../../src/guards/index.js";
import { LOG_FILE } from "../../src/log/index.js";
import {
  loadMapping,
  privacyContext,
  replaceRealValuesInVault,
  syncOnce,
  type Project,
} from "../../src/engine/index.js";
import { linkedProject, type LinkedProject } from "../watch/project.js";

let linked: LinkedProject;
let project: Project;

beforeEach(async () => {
  linked = await linkedProject();
  await writeFile(
    path.join(path.dirname(linked.docs), "PRIVATE.md"),
    "## Placeholders\n\n| `myhost` | `DESK-FAKE01` | host |\n",
  );
  project = await linked.open();
});
afterEach(async () => {
  await linked.cleanup();
});

const read = (file: string) => readFile(file, "utf8").catch(() => null);

describe("the real-value fix (REQ-13.3)", () => {
  it("replaces the hostname with its placeholder, after which the note syncs", async () => {
    await writeFile(path.join(linked.docs, "a.md"), "a\n");
    await syncOnce(project);
    await writeFile(path.join(linked.vaultDocs, "a.md"), "ssh DESK-FAKE01\n");
    const held = await syncOnce(project);
    expect(held.outcome === "synced" && held.plan.notices[0]).toMatchObject({
      code: "held-back",
      fix: "replace-real-values",
    });
    expect(await read(path.join(linked.docs, "a.md"))).toBe("a\n");

    expect(await replaceRealValuesInVault(project, "docs/a.md")).toBe(true);
    await syncOnce(project);
    expect(await read(path.join(linked.docs, "a.md"))).toBe("ssh myhost\n");
    expect(await read(path.join(linked.vaultDocs, "a.md"))).toBe("ssh myhost\n");
    expect(await read(path.join(project.store.dir, "log", LOG_FILE))).not.toContain("DESK-FAKE01");
  });

  it("reports when there's nothing it can replace", async () => {
    await writeFile(path.join(linked.vaultDocs, "b.md"), "DESK-FAKE01x\n");
    expect(await replaceRealValuesInVault(project, "docs/b.md")).toBe(false);
    expect(await replaceRealValuesInVault(project, "missing.md")).toBe(false);
  });
});

describe("privacyContext (REQ-13.0.5)", () => {
  it("knows the vault's private notes, for checking repo docs", async () => {
    await mkdir(path.join(linked.vaultDocs, "private"));
    await writeFile(path.join(linked.vaultDocs, "private", "server-notes.md"), "s\n");
    await writeFile(path.join(linked.vaultDocs, "marked.md"), "---\nproject-docs: private\n---\n");
    await syncOnce(project);
    const ctx = await privacyContext(project);
    const text = "[a](private/server-notes.md) [b](marked.md) DESK-FAKE01\n";
    expect(checkRepoDoc(text, "docs/guide.md", ctx).map((f) => f.code)).toEqual([
      "links-private",
      "links-private",
      "real-value",
    ]);
  });
});

describe("loadMapping", () => {
  it("treats the empty table that setup creates as nothing to protect, not a problem", async () => {
    const repo = path.dirname(linked.docs);
    await writeFile(
      path.join(repo, "PRIVATE.md"),
      "## Placeholders\n\n| Placeholder in the repo | Real value | What it is |\n| --- | --- | --- |\n",
    );
    const empty = await loadMapping(repo);
    expect(empty.problem).toBeUndefined();
    expect(empty.mapping?.size).toBe(0);
    await writeFile(path.join(repo, "PRIVATE.md"), "no table\n");
    expect((await loadMapping(repo)).problem).toMatch(/can't be read/);
  });
});
