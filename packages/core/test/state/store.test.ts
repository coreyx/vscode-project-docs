import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  STATE_FORMAT,
  StateStore,
  projectStateDir,
  stateRoot,
  type Index,
} from "../../src/state/index.js";
import { sha256 } from "../../src/scan/index.js";

const PROJECT = "pd_3f2c9a1e-7b4d-4c1a-9e2f-5a6b7c8d9e0f";
let dir: string;
let store: StateStore;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "pd-state-"));
  store = new StateStore(dir, PROJECT);
  await store.ensure();
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("state location", () => {
  it("uses the platform's application-data folder", () => {
    expect(
      stateRoot({ APPDATA: "C:\\Users\\me\\AppData\\Roaming" }, "win32", "C:\\Users\\me"),
    ).toBe("C:\\Users\\me\\AppData\\Roaming\\project-docs");
    expect(stateRoot({}, "darwin", "/Users/me")).toBe(
      "/Users/me/Library/Application Support/project-docs",
    );
    expect(stateRoot({}, "linux", "/home/me")).toBe("/home/me/.local/share/project-docs");
    expect(stateRoot({ XDG_DATA_HOME: "/data" }, "linux", "/home/me")).toBe("/data/project-docs");
  });

  it("can be overridden, for tests", () => {
    expect(stateRoot({ PROJECT_DOCS_STATE_DIR: "/tmp/x" }, "linux", "/home/me")).toBe("/tmp/x");
  });

  it("keeps each project in its own folder and rejects unsafe ids", () => {
    expect(projectStateDir(PROJECT, "/root")).toBe(path.join("/root", "projects", PROJECT));
    expect(() => projectStateDir("../escape", "/root")).toThrow("Invalid project id");
  });
});

describe("index", () => {
  it("starts empty for a new project", async () => {
    expect(await store.loadIndex()).toEqual({ index: store.emptyIndex(), recovered: false });
  });

  it("round-trips through disk", async () => {
    const index: Index = {
      format: STATE_FORMAT,
      projectId: PROJECT,
      entries: {
        "a.md": {
          key: "a.md",
          kind: "markdown",
          baseHash: sha256("a"),
          repoLineEnding: "crlf",
          vaultLineEnding: "lf",
          state: "synced",
          reasons: [],
        },
      },
    };
    await store.saveIndex(index);
    expect(await store.loadIndex()).toEqual({ index, recovered: false });
  });

  it("recovers from a corrupt or foreign index by starting empty (REQ-19.0.4)", async () => {
    await writeFile(path.join(dir, "index.json"), "{ not json");
    expect(await store.loadIndex()).toEqual({ index: store.emptyIndex(), recovered: true });
    await writeFile(
      path.join(dir, "index.json"),
      JSON.stringify({ format: STATE_FORMAT, projectId: "pd_00000000-other", entries: {} }),
    );
    expect((await store.loadIndex()).recovered).toBe(true);
  });

  it("treats a deleted state folder as a new project (REQ-19.3)", async () => {
    await store.saveIndex(store.emptyIndex());
    await rm(dir, { recursive: true, force: true });
    expect(await store.loadIndex()).toEqual({ index: store.emptyIndex(), recovered: false });
  });
});

describe("blobs", () => {
  it("stores content by hash, idempotently", async () => {
    const hash = await store.putBlob("hello\n");
    expect(hash).toBe(sha256("hello\n"));
    expect(await store.putBlob("hello\n")).toBe(hash);
    expect(new TextDecoder().decode((await store.getBlob(hash)) ?? new Uint8Array())).toBe(
      "hello\n",
    );
    expect(await store.getBlob(sha256("missing"))).toBeNull();
  });

  it("rejects anything but a SHA-256 as a blob name", async () => {
    await expect(store.getBlob("../index.json")).resolves.toBeNull();
    await expect(store.putBlob("x")).resolves.toMatch(/^[0-9a-f]{64}$/);
  });

  it("collects unreferenced blobs", async () => {
    const keep = await store.putBlob("keep");
    const drop = await store.putBlob("drop");
    expect(await store.collectGarbage(new Set([keep]))).toBe(1);
    expect(await store.getBlob(keep)).not.toBeNull();
    expect(await store.getBlob(drop)).toBeNull();
  });

  it("collects nothing when there are no blobs", async () => {
    expect(await store.collectGarbage(new Set())).toBe(0);
  });
});

describe("conflicts", () => {
  it("saves, lists in key order, and removes conflicts", async () => {
    const make = (key: string) => ({
      key,
      baseHash: null,
      repoHash: sha256(`${key} repo`),
      vaultHash: sha256(`${key} vault`),
      createdAt: "2026-10-22T00:00:00.000Z",
    });
    await store.saveConflict(make("z.md"));
    await store.saveConflict(make("notes:odd?.md"));
    expect((await store.listConflicts()).map((c) => c.key)).toEqual(["notes:odd?.md", "z.md"]);
    await store.removeConflict("z.md");
    expect((await store.listConflicts()).map((c) => c.key)).toEqual(["notes:odd?.md"]);
  });

  it("lists nothing when there are no conflicts", async () => {
    expect(await store.listConflicts()).toEqual([]);
  });
});

describe("journal and pending bulk pass", () => {
  it("saves, loads and clears the journal", async () => {
    expect(await store.loadJournal()).toBeNull();
    await store.saveJournal({ actions: [1, 2] });
    expect(await store.loadJournal()).toEqual({ actions: [1, 2] });
    await store.clearJournal();
    expect(await store.loadJournal()).toBeNull();
  });

  it("saves, loads and clears a pending bulk pass", async () => {
    expect(await store.loadPendingBulk()).toBeNull();
    await store.savePendingBulk({ destructive: 30 });
    expect(await store.loadPendingBulk()).toEqual({ destructive: 30 });
    await store.clearPendingBulk();
    expect(await store.loadPendingBulk()).toBeNull();
  });

  it("leaves no temporary files behind", async () => {
    await store.saveJournal({ a: 1 });
    expect((await readdir(dir)).filter((name) => name.includes(".pd-tmp-"))).toEqual([]);
  });
});
