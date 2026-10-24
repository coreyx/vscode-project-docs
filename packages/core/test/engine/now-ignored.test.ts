import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import * as path from "node:path";
import {
  keepSyncingIgnored,
  stopSyncingIgnored,
  syncOnce,
  type Project,
} from "../../src/engine/index.js";
import { syncIgnoredPattern } from "../../src/records/index.js";
import {
  ignoredChoicesPath,
  parseIgnoredChoices,
  parseStatusFile,
  serializeIgnoredChoices,
  statusFilePath,
  type IgnoredChoice,
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
const repoDoc = (key: string) => path.join(linked.docs, ...key.split("/"));
const vaultNote = (key: string) => path.join(linked.vaultDocs, ...key.split("/"));

/** The link file's `syncIgnored` patterns. */
async function syncIgnored(): Promise<unknown> {
  const committed = JSON.parse((await read(path.join(linked.repo, ".project-docs.json"))) ?? "{}");
  return committed.settings?.syncIgnored;
}

/** The problems in status.json, as kind and path. */
async function problems(): Promise<{ kind: string; path: string; fix?: string }[]> {
  const status = parseStatusFile(await read(statusFilePath(linked.vaultFolder)));
  return (status?.items ?? []).map(({ kind, path: p, fix }) => ({
    kind,
    path: p,
    ...(fix ? { fix } : {}),
  }));
}

/** Syncs two notes in `drafts/`, then makes git ignore the folder and edits each note on one side. */
async function draftsBecomeIgnored(): Promise<void> {
  // Enough other docs that bringing both edits across stays under the bulk guard's threshold.
  for (let i = 0; i < 10; i++) await writeFile(repoDoc(`guide-${i}.md`), `guide ${i}\n`);
  await mkdir(repoDoc("drafts"), { recursive: true });
  await writeFile(repoDoc("drafts/a.md"), "a\n");
  await writeFile(repoDoc("drafts/b.md"), "b\n");
  await syncOnce(project);
  await writeFile(path.join(linked.repo, ".gitignore"), "/docs/drafts/\n");
  await writeFile(vaultNote("drafts/a.md"), "a, edited in the vault\n");
  await writeFile(repoDoc("drafts/b.md"), "b, edited in the repo\n");
  await syncOnce(project);
}

/** Records choices as the Obsidian plugin does. */
async function choose(choices: IgnoredChoice[]): Promise<void> {
  await mkdir(path.dirname(ignoredChoicesPath(linked.vaultFolder)), { recursive: true });
  await writeFile(ignoredChoicesPath(linked.vaultFolder), serializeIgnoredChoices(choices));
}

describe("notes that became ignored (REQ-3.0.8, AC 3.7)", () => {
  it("are reported once for the folder, in status.json, and each copy keeps its own edit", async () => {
    await draftsBecomeIgnored();
    expect(await problems()).toEqual([
      { kind: "now-ignored", path: "docs/drafts/", fix: "sync-ignored" },
    ]);
    expect(await read(repoDoc("drafts/a.md"))).toBe("a\n");
    expect(await read(vaultNote("drafts/b.md"))).toBe("b\n");
    // Still reported on the next pass.
    await syncOnce(project);
    expect(await problems()).toHaveLength(1);
  });

  it("sync again from their base with Keep syncing it, bringing each side's edit across", async () => {
    await draftsBecomeIgnored();
    expect(await keepSyncingIgnored(project, "docs/drafts/")).toBe(true);
    expect(await syncIgnored()).toEqual(["/docs/drafts/"]);
    expect(await keepSyncingIgnored(project, "docs/drafts/")).toBe(false);
    await syncOnce(project);
    expect(await read(repoDoc("drafts/a.md"))).toBe("a, edited in the vault\n");
    expect(await read(vaultNote("drafts/b.md"))).toBe("b, edited in the repo\n");
    expect(await problems()).toEqual([]);
  });

  it("stop being reported with Stop syncing it, and neither copy changes", async () => {
    await draftsBecomeIgnored();
    expect(await stopSyncingIgnored(project, "docs/drafts/")).toBe(true);
    expect(await stopSyncingIgnored(project, "docs/drafts/")).toBe(false);
    await syncOnce(project);
    expect(await problems()).toEqual([]);
    expect(await read(repoDoc("drafts/a.md"))).toBe("a\n");
    expect(await read(vaultNote("drafts/a.md"))).toBe("a, edited in the vault\n");
    expect(await syncIgnored()).toEqual([]);
  });

  it("carry out a Keep syncing it choice made in Obsidian, once however often it's read", async () => {
    await draftsBecomeIgnored();
    await choose([{ path: "docs/drafts/", choice: "sync" }]);
    await syncOnce(project);
    expect(await read(repoDoc("drafts/a.md"))).toBe("a, edited in the vault\n");
    await syncOnce(project);
    expect(await syncIgnored()).toEqual(["/docs/drafts/"]);
    expect(await problems()).toEqual([]);
  });

  it("carry out a Stop syncing it choice made in Obsidian, once however often it's read", async () => {
    await draftsBecomeIgnored();
    await choose([{ path: "docs/drafts/", choice: "stop" }]);
    await syncOnce(project);
    await syncOnce(project);
    expect(await problems()).toEqual([]);
    expect(await read(repoDoc("drafts/a.md"))).toBe("a\n");
    expect(await syncIgnored()).toEqual([]);
  });

  it("ignore a choices file that can't be read, and keep reporting", async () => {
    await draftsBecomeIgnored();
    await mkdir(path.dirname(ignoredChoicesPath(linked.vaultFolder)), { recursive: true });
    await writeFile(ignoredChoicesPath(linked.vaultFolder), "{ not json");
    await syncOnce(project);
    expect(await problems()).toHaveLength(1);
  });
});

describe("ignored-choices.json", () => {
  it("round-trips, sorted by path, and drops entries it doesn't understand", () => {
    const text = serializeIgnoredChoices([
      { path: "z.md", choice: "stop" },
      { path: "docs/drafts/", choice: "sync" },
    ]);
    expect(parseIgnoredChoices(text)).toEqual([
      { path: "docs/drafts/", choice: "sync" },
      { path: "z.md", choice: "stop" },
    ]);
    expect(
      parseIgnoredChoices(
        JSON.stringify({
          format: 1,
          choices: [{ path: "a/", choice: "maybe" }, { choice: "sync" }],
        }),
      ),
    ).toEqual([]);
    expect(parseIgnoredChoices(JSON.stringify({ format: 2, choices: [] }))).toEqual([]);
    expect(parseIgnoredChoices(null)).toEqual([]);
  });
});

describe("syncIgnoredPattern", () => {
  it("anchors the path to the docs folder, and escapes wildcards", () => {
    expect(syncIgnoredPattern("drafts/")).toBe("/drafts/");
    expect(syncIgnoredPattern("notes/solo.md")).toBe("/notes/solo.md");
    expect(syncIgnoredPattern("a[1]*?.md")).toBe("/a\\[1]\\*\\?.md");
    expect(syncIgnoredPattern("trailing ")).toBe("/trailing\\ ");
  });
});
