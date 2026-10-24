import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { confirmSyncable, syncOnce, type Project } from "../../src/engine/index.js";
import {
  confirmationsPath,
  markdownHash,
  parseStatusFile,
  serializeConfirmations,
  statusFilePath,
} from "../../src/status/index.js";
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

const read = (file: string) => readFile(file, "utf8").catch(() => null);
const marked = "---\nproject-docs: private\n---\nplan\n";
const unmarked = "plan\n";

/** Syncs a private note once, then removes its marker by hand. */
async function unmarkByHand(): Promise<void> {
  await writeFile(path.join(linked.vaultDocs, "plan.md"), marked);
  await syncOnce(project);
  await writeFile(path.join(linked.vaultDocs, "plan.md"), unmarked);
}

describe("a note that stops being private (REQ-10.0.7, REQ-10.4)", () => {
  it("is held, reported in status.json, and synced only after confirmSyncable", async () => {
    await unmarkByHand();
    const held = await syncOnce(project);
    expect(held.outcome === "synced" && held.plan.notices).toMatchObject([
      { key: "docs/plan.md", code: "was-private", fix: "confirm-syncable" },
    ]);
    expect(await read(path.join(linked.docs, "plan.md"))).toBeNull();
    const status = parseStatusFile(await read(statusFilePath(linked.vaultFolder)));
    expect(status?.items).toMatchObject([{ kind: "was-private", fix: "confirm-syncable" }]);

    // A second pass doesn't release it on its own.
    await syncOnce(project);
    expect(await read(path.join(linked.docs, "plan.md"))).toBeNull();

    expect(await confirmSyncable(project, "docs/plan.md")).toBe(true);
    await syncOnce(project);
    expect(await read(path.join(linked.docs, "plan.md"))).toBe(unmarked);
    expect(parseStatusFile(await read(statusFilePath(linked.vaultFolder)))?.items).toEqual([]);
  });

  it("is synced without asking again when Obsidian recorded the confirmation (REQ-10.6)", async () => {
    await unmarkByHand();
    await mkdir(path.dirname(confirmationsPath(linked.vaultFolder)), { recursive: true });
    await writeFile(
      confirmationsPath(linked.vaultFolder),
      serializeConfirmations([{ path: "docs/plan.md", sha256: markdownHash(unmarked) }]),
    );
    await syncOnce(project);
    expect(await read(path.join(linked.docs, "plan.md"))).toBe(unmarked);
  });

  it("stays held when confirmations.json can't be read", async () => {
    await unmarkByHand();
    await mkdir(path.dirname(confirmationsPath(linked.vaultFolder)), { recursive: true });
    await writeFile(confirmationsPath(linked.vaultFolder), "{ not json");
    await syncOnce(project);
    expect(await read(path.join(linked.docs, "plan.md"))).toBeNull();
  });

  it("is held when an unmarked file is moved out of the private folder (REQ-10.5)", async () => {
    await mkdir(path.join(linked.vaultDocs, "private"));
    await writeFile(path.join(linked.vaultDocs, "private", "plan.md"), unmarked);
    await syncOnce(project);
    await rename(
      path.join(linked.vaultDocs, "private", "plan.md"),
      path.join(linked.vaultDocs, "plan.md"),
    );
    const held = await syncOnce(project);
    expect(held.outcome === "synced" && held.plan.notices.map((n) => n.code)).toEqual([
      "was-private",
    ]);
    expect(await read(path.join(linked.docs, "plan.md"))).toBeNull();
  });

  it("can't be confirmed when it isn't waiting", async () => {
    await writeFile(path.join(linked.vaultDocs, "a.md"), "a\n");
    await syncOnce(project);
    expect(await confirmSyncable(project, "docs/a.md")).toBe(false);
    expect(await confirmSyncable(project, "missing.md")).toBe(false);
  });
});
