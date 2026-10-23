import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  CORE_VERSION,
  DEFAULT_SETTINGS,
  acquireLock,
  committedRecord,
  isLockHandle,
  linkNotePathFor,
  localRecord,
  newProjectId,
  projectStateDir,
  writeLink,
  type OpenOptions,
} from "@specdevship/project-docs-core";
import { EXIT, describeHolder, main, type Io } from "../src/main.js";

let root: string;
let repo: string;
let vaultRoot: string;
let vaultFolder: string;
let stateRoot: string;
let projectId: string;
let out: string[];
let err: string[];
const trashed: string[] = [];

const options = (): OpenOptions => ({
  repoTrash: async (p) => {
    trashed.push(p);
    await rm(p);
  },
  stateRoot,
});
const io = (cwd = repo): Io => ({ out: (t) => out.push(t), err: (t) => err.push(t), cwd });
const run = (args: string[], cwd?: string) => main(args, io(cwd), options());

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "pd-cli-"));
  repo = path.join(root, "repo");
  vaultRoot = path.join(root, "vault");
  vaultFolder = path.join(vaultRoot, "Projects", "repo");
  stateRoot = path.join(root, "state");
  await mkdir(path.join(repo, "docs"), { recursive: true });
  await mkdir(vaultFolder, { recursive: true });
  spawnSync("git", ["init", "-q", repo]);
  projectId = newProjectId();
  await writeLink(
    repo,
    committedRecord({
      projectId,
      docsFolder: "docs",
      vaultFolder: "Projects/repo",
      settings: DEFAULT_SETTINGS,
    }),
    localRecord({
      projectId,
      vaultRoot,
      vaultFolderPath: vaultFolder,
      linkNotePath: linkNotePathFor(vaultFolder, DEFAULT_SETTINGS.folderNotePattern),
    }),
  );
  out = [];
  err = [];
  trashed.length = 0;
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("basics", () => {
  it("prints the version and help", async () => {
    expect(await run(["--version"])).toBe(EXIT.ok);
    expect(out).toEqual([CORE_VERSION]);
    expect(await run([])).toBe(EXIT.ok);
    expect(await run(["--help"])).toBe(EXIT.ok);
    expect(out.slice(1).every((t) => t.startsWith("Usage: project-docs"))).toBe(true);
  });

  it("rejects an unknown command or option", async () => {
    expect(await run(["frobnicate"])).toBe(EXIT.error);
    expect(err[0]).toContain("Unknown command: frobnicate");
    expect(await run(["sync", "--nope"])).toBe(EXIT.error);
  });
});

describe("where (REQ-18.2)", () => {
  it("prints the vault folder, from anywhere in the repo", async () => {
    expect(await run(["where"], path.join(repo, "docs"))).toBe(EXIT.ok);
    expect(out).toEqual([vaultFolder]);
  });

  it("explains when the repo isn't linked", async () => {
    const elsewhere = path.join(root, "unlinked");
    await mkdir(elsewhere);
    expect(await run(["where"], elsewhere)).toBe(EXIT.error);
    expect(err[0]).toContain("isn't in a repo linked to an Obsidian vault");
  });

  it("explains when this machine needs to re-link", async () => {
    await rm(path.join(repo, ".project-docs.local.json"));
    expect(await run(["where"])).toBe(EXIT.error);
    expect(err[0]).toContain("link it again to Projects/repo");
  });
});

describe("sync (REQ-18.1)", () => {
  it("syncs an agent's repo edit to the vault with VS Code closed", async () => {
    await writeFile(path.join(repo, "docs", "plan.md"), "Edited by an agent\n");
    expect(await run(["sync"])).toBe(EXIT.ok);
    expect(await readFile(path.join(vaultFolder, "plan.md"), "utf8")).toBe("Edited by an agent\n");
    expect(out[0]).toBe("Synced: 1 change applied.");
  });

  it("reports in JSON", async () => {
    await writeFile(path.join(vaultFolder, "note.md"), "From Obsidian\n");
    expect(await run(["sync", "--json"])).toBe(EXIT.ok);
    expect(JSON.parse(out.join("\n"))).toMatchObject({ outcome: "synced", applied: 1 });
  });

  it("refuses while VS Code holds the lock, naming it (REQ-18.3)", async () => {
    const lock = await acquireLock(projectStateDir(projectId, stateRoot), "vscode", {
      window: "repo",
    });
    expect(isLockHandle(lock)).toBe(true);
    expect(await run(["sync"])).toBe(EXIT.locked);
    expect(err[0]).toBe("Not syncing: VS Code (window repo) is already syncing this project.");
    if (isLockHandle(lock)) await lock.release();
  });

  it("stops at the bulk guard until --yes (REQ-7.2)", async () => {
    for (let i = 0; i < 30; i++) await writeFile(path.join(repo, "docs", `d${i}.md`), `${i}\n`);
    expect(await run(["sync"])).toBe(EXIT.ok);
    for (let i = 0; i < 25; i++) await rm(path.join(repo, "docs", `d${i}.md`));
    expect(await run(["sync"])).toBe(EXIT.bulk);
    expect(err.at(-1)).toContain("would delete or overwrite 25 files");
    expect(await readFile(path.join(vaultFolder, "d0.md"), "utf8")).toBe("0\n");
    expect(await run(["sync", "--yes"])).toBe(EXIT.ok);
    await expect(readFile(path.join(vaultFolder, "d0.md"), "utf8")).rejects.toThrow();
  });
});

describe("status", () => {
  it("shows what would change without changing anything", async () => {
    await writeFile(path.join(repo, "docs", "a.md"), "a\n");
    expect(await run(["status"])).toBe(EXIT.ok);
    expect(out).toEqual(["  copy a.md from the repo to the vault"]);
    await expect(readFile(path.join(vaultFolder, "a.md"), "utf8")).rejects.toThrow();
  });

  it("says when there's nothing to do, and reports notices", async () => {
    expect(await run(["status"])).toBe(EXIT.ok);
    expect(out).toEqual(["Nothing to sync."]);
    await writeFile(path.join(vaultFolder, "bad.md"), "---\nproject-docs: typo\n---\n");
    out.length = 0;
    await run(["status", "--json"]);
    expect(JSON.parse(out.join("\n")).notices[0]).toMatchObject({ code: "invalid-rule" });
  });

  it("reports a note that stopped being private, and has no way to confirm it (REQ-10.0.8)", async () => {
    await writeFile(path.join(vaultFolder, "plan.md"), "---\nproject-docs: private\n---\nplan\n");
    expect(await run(["sync"])).toBe(EXIT.ok);
    await writeFile(path.join(vaultFolder, "plan.md"), "plan\n");
    out.length = 0;
    expect(await run(["sync", "--yes"])).toBe(EXIT.ok);
    expect(out).toContain(
      "! plan.md was private, so it isn't synced to the repo until you confirm in VS Code or Obsidian",
    );
    await expect(readFile(path.join(repo, "docs", "plan.md"), "utf8")).rejects.toThrow();
    expect(await run(["sync", "--confirm", "plan.md"])).toBe(EXIT.error);
  });
});

describe("describeHolder", () => {
  it("names who holds the lock", () => {
    const base = { pid: 1, host: "h", token: "t", heartbeatAt: "" };
    expect(describeHolder({ ...base, owner: "vscode" })).toBe("VS Code");
    expect(describeHolder({ ...base, owner: "cli" })).toBe("another project-docs run");
    expect(describeHolder(null)).toBe("another Project Docs process");
  });
});
