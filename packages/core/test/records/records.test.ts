import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import * as path from "node:path";
import {
  COMMITTED_FILE,
  COMMITTED_SCHEMA,
  DEFAULT_SETTINGS,
  LOCAL_FILE,
  UnsafeRecordError,
  committedRecord,
  deepLinkFor,
  ensureGitIgnored,
  isUnsafeRelativePath,
  linkNotePathFor,
  localRecord,
  newProjectId,
  obsidianOpenUri,
  readLink,
  readLinkNoteRepo,
  readLinkNoteUid,
  repoPathForVault,
  setDeepLinks,
  setLinkNoteUid,
  validateCommitted,
  vscodeOpenUri,
  writeLink,
  writeLinkNote,
} from "../../src/records/index.js";

const gitAvailable = spawnSync("git", ["--version"]).status === 0;

let root: string;
let repo: string;
let vault: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "pd-records-"));
  repo = path.join(root, "my-repo");
  vault = path.join(root, "My Private Vault");
  spawnSync("git", ["init", "-q", repo]);
  await writeFile(path.join(root, ".keep"), "");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function link(projectId = newProjectId(), settings = DEFAULT_SETTINGS) {
  const vaultFolderPath = path.join(vault, "Projects", "my-repo");
  return {
    committed: committedRecord({
      projectId,
      docsFolder: "docs",
      vaultFolder: "Projects/my-repo",
      settings,
    }),
    local: localRecord({
      projectId,
      vaultRoot: vault,
      vaultFolderPath,
      linkNotePath: linkNotePathFor(vaultFolderPath, settings.folderNotePattern),
    }),
  };
}

describe("writing and reading the records", () => {
  it("round-trips a link", async () => {
    const { committed, local } = link();
    await writeLink(repo, committed, local);
    expect(await readLink(repo)).toEqual({ state: "linked", committed, local });
  });

  it("publishes no absolute path, home folder or vault name (REQ-2.1)", async () => {
    const { committed, local } = link();
    await writeLink(repo, committed, local);
    const published = await readFile(path.join(repo, COMMITTED_FILE), "utf8");
    expect(published).not.toMatch(/[A-Za-z]:[\\/]/);
    expect(published).not.toContain(homedir());
    expect(published).not.toContain(root);
    expect(published).not.toContain("My Private Vault");
    expect(JSON.parse(published)).toMatchObject({
      docsFolder: "docs",
      vaultFolder: "Projects/my-repo",
    });
  });

  it.runIf(gitAvailable)("keeps the machine-local record out of git (REQ-2.2)", async () => {
    const { committed, local } = link();
    await writeLink(repo, committed, local);
    expect(spawnSync("git", ["check-ignore", "-q", LOCAL_FILE], { cwd: repo }).status).toBe(0);
    expect(spawnSync("git", ["check-ignore", "-q", COMMITTED_FILE], { cwd: repo }).status).toBe(1);
  });

  it("doesn't add the ignore rule twice, and keeps .gitignore's line endings", async () => {
    await writeFile(path.join(repo, ".gitignore"), "node_modules/\r\ndist/");
    await ensureGitIgnored(repo, LOCAL_FILE);
    await ensureGitIgnored(repo, LOCAL_FILE);
    expect(await readFile(path.join(repo, ".gitignore"), "utf8")).toBe(
      `node_modules/\r\ndist/\r\n${LOCAL_FILE}\r\n`,
    );
  });

  it("is unlinked when there's no committed record", async () => {
    expect(await readLink(repo)).toEqual({ state: "unlinked" });
  });

  it("offers a re-link keeping the project id when the local record is missing (REQ-2.5)", async () => {
    const projectId = newProjectId();
    const { committed, local } = link(projectId);
    await writeLink(repo, committed, local);
    await rm(path.join(repo, LOCAL_FILE));
    expect(await readLink(repo)).toEqual({ state: "relink", committed });
  });

  it("treats a local record for another project as missing", async () => {
    const { committed } = link();
    const { local: stale } = link();
    await writeFile(path.join(repo, COMMITTED_FILE), JSON.stringify(committed));
    await writeFile(path.join(repo, LOCAL_FILE), JSON.stringify(stale));
    expect((await readLink(repo)).state).toBe("relink");
  });

  it("reports an invalid committed record", async () => {
    await writeFile(path.join(repo, COMMITTED_FILE), JSON.stringify({ format: 1, projectId: "x" }));
    const state = await readLink(repo);
    expect(state.state).toBe("invalid");
    await writeFile(path.join(repo, COMMITTED_FILE), "{ not json");
    expect((await readLink(repo)).state).toBe("invalid");
  });

  it("refuses to write a committed record with an absolute path", async () => {
    const { committed, local } = link();
    await expect(
      writeLink(repo, { ...committed, vaultFolder: "C:\\Users\\me\\Vault\\Projects" }, local),
    ).rejects.toBeInstanceOf(UnsafeRecordError);
    await expect(
      writeLink(
        repo,
        { ...committed, settings: { ...committed.settings, privateSubfolder: "/home/me/x" } },
        local,
      ),
    ).rejects.toBeInstanceOf(UnsafeRecordError);
  });
});

describe("validation", () => {
  it.each(["/abs", "C:\\x", "c:/x", "\\\\server\\share", "../up", "a/../../b", "~/x"])(
    "rejects %s as a relative path",
    (value) => {
      expect(isUnsafeRelativePath(value)).toBe(true);
    },
  );

  it("accepts ordinary relative paths", () => {
    expect(isUnsafeRelativePath("docs")).toBe(false);
    expect(isUnsafeRelativePath("Projects/my repo")).toBe(false);
  });

  it("fills in default settings and reports wrong types", () => {
    const id = newProjectId();
    const ok = validateCommitted({
      format: 1,
      projectId: id,
      docsFolder: "docs",
      vaultFolder: "P",
    });
    expect(ok).toMatchObject({ settings: DEFAULT_SETTINGS });
    const bad = validateCommitted({
      format: 1,
      projectId: id,
      docsFolder: "docs",
      vaultFolder: "P",
      settings: { syncAttachments: "yes", privateSubfolder: "a/b", folderNotePattern: "x.txt" },
      deepLink: "https://example.com",
    });
    expect("problems" in bad && bad.problems).toEqual([
      "settings.syncAttachments must be a boolean",
      "settings.privateSubfolder must be a single folder name",
      "settings.folderNotePattern must name a Markdown file",
      "deepLink must be an obsidian://adv-uri?uid= link",
    ]);
  });

  it("takes syncIgnored as a list of patterns, and nothing else (design decision 20)", () => {
    const base = { format: 1, projectId: newProjectId(), docsFolder: "docs", vaultFolder: "P" };
    expect(validateCommitted({ ...base, settings: { syncIgnored: ["/scratch/"] } })).toMatchObject({
      settings: { syncIgnored: ["/scratch/"] },
    });
    for (const syncIgnored of ["/scratch/", [1], { a: "b" }]) {
      const bad = validateCommitted({ ...base, settings: { syncIgnored } });
      expect("problems" in bad && bad.problems).toEqual([
        "settings.syncIgnored must be a list of patterns",
      ]);
    }
  });

  it("takes rootFiles as Markdown file names at the repo root (design decision 21)", () => {
    const base = { format: 1, projectId: newProjectId(), docsFolder: "docs", vaultFolder: "P" };
    expect(validateCommitted(base)).toMatchObject({
      settings: { rootFiles: ["README.md", "CHANGELOG.md", "RELEASE_NOTES.md"] },
    });
    expect(validateCommitted({ ...base, settings: { rootFiles: [] } })).toMatchObject({
      settings: { rootFiles: [] },
    });
    const problems = (rootFiles: unknown) => {
      const result = validateCommitted({ ...base, settings: { rootFiles } });
      return "problems" in result ? result.problems : [];
    };
    expect(problems(["CONTRIBUTING.md", "notes.MD"])).toEqual([]);
    expect(problems(["docs/a.md"])).toEqual([
      "settings.rootFiles can list only Markdown files at the top of the repo root, such as README.md, not docs/a.md",
    ]);
    expect(problems(["LICENSE"])).toHaveLength(1);
    expect(problems(["a\\b.md"])).toHaveLength(1);
    expect(problems(["PRIVATE.md", "notes.private.md"])).toEqual([
      "settings.rootFiles can't list PRIVATE.md, which never syncs",
      "settings.rootFiles can't list notes.private.md, which never syncs",
    ]);
    expect(problems("README.md")).toEqual(["settings.rootFiles must be a list of file names"]);
  });

  it("ships a JSON schema matching the record", () => {
    expect(COMMITTED_SCHEMA.required).toEqual(["format", "projectId", "docsFolder", "vaultFolder"]);
  });
});

describe("Advanced URI deep links (REQ-2.0.8)", () => {
  it("adds the deep link only while the setting is on, with no vault name (REQ-2.6, 2.7)", () => {
    const id = newProjectId();
    expect(
      committedRecord({
        projectId: id,
        docsFolder: "docs",
        vaultFolder: "P",
        settings: DEFAULT_SETTINGS,
      }).deepLink,
    ).toBeUndefined();
    const on = committedRecord({
      projectId: id,
      docsFolder: "docs",
      vaultFolder: "P",
      settings: { ...DEFAULT_SETTINGS, advancedUriDeepLinks: true },
    });
    expect(on.deepLink).toBe(`obsidian://adv-uri?uid=${id}`);
    expect(on.deepLink).not.toContain("vault=");
    expect(deepLinkFor(id)).toBe(on.deepLink);
  });
});

describe("the link note (REQ-2.0.2)", () => {
  it("is the folder note by default (REQ-2.8)", () => {
    expect(
      linkNotePathFor(path.join(vault, "Projects", "my-repo"), "{folder}/{folderName}.md"),
    ).toBe(path.join(vault, "Projects", "my-repo", "my-repo.md"));
    expect(linkNotePathFor(path.join(vault, "P"), "{folder}/index.md")).toBe(
      path.join(vault, "P", "index.md"),
    );
  });

  it("creates the note with the link properties and an open-repo link", async () => {
    const note = path.join(vault, "Projects", "my-repo", "my-repo.md");
    const id = newProjectId();
    await writeLinkNote(note, {
      projectId: id,
      repoPath: repo,
      openRepoUri: "vscode://file/x",
      deepLinks: false,
    });
    const text = await readFile(note, "utf8");
    expect(text).toContain(`project-docs-id: ${id}`);
    expect(text).toContain("[Open the repo in VS Code](vscode://file/x)");
    expect(text).not.toContain("uid:");
    expect(await readLinkNoteRepo(note)).toBe(repo);
  });

  it("adds to an existing folder note without changing its content, once (REQ-2.8)", async () => {
    const note = path.join(vault, "note.md");
    await writeLinkNote(note, {
      projectId: "pd_x",
      repoPath: "/r",
      openRepoUri: "vscode://file/r",
      deepLinks: false,
    });
    await writeFile(note, "---\ntags: [project]\n---\n# My project\n\nMy own notes.\n");
    const id = newProjectId();
    await writeLinkNote(note, {
      projectId: id,
      repoPath: "/r",
      openRepoUri: "vscode://file/r",
      deepLinks: true,
    });
    await writeLinkNote(note, {
      projectId: id,
      repoPath: "/r",
      openRepoUri: "vscode://file/r",
      deepLinks: true,
    });
    expect(await readFile(note, "utf8")).toBe(
      `---\ntags: [project]\nproject-docs-id: ${id}\nproject-docs-repo: '/r'\nuid: ${id}\n---\n# My project\n\nMy own notes.\n\n[Open the repo in VS Code](vscode://file/r)\n`,
    );
  });

  it("reads nothing from a missing note", async () => {
    expect(await readLinkNoteRepo(path.join(vault, "missing.md"))).toBeNull();
  });
});

describe("paths across WSL (REQ-2.0.4)", () => {
  const wsl = { distro: "Ubuntu", automountRoot: "/mnt/" };

  it("records a WSL repo in the form the Windows vault side opens", () => {
    expect(repoPathForVault("/home/me/my-repo", wsl, true)).toBe(
      "\\\\wsl.localhost\\Ubuntu\\home\\me\\my-repo",
    );
    expect(repoPathForVault("/home/me/my-repo", wsl, false)).toBe("/home/me/my-repo");
    expect(repoPathForVault("C:\\src\\repo", null, true)).toBe("C:\\src\\repo");
  });

  it("builds VS Code links for local and WSL repos (REQ-2.4)", () => {
    expect(vscodeOpenUri("C:\\src\\my repo", null)).toBe("vscode://file/C:/src/my%20repo");
    expect(vscodeOpenUri("/home/me/repo", null)).toBe("vscode://file/home/me/repo");
    expect(vscodeOpenUri("/home/me/repo", wsl)).toBe(
      "vscode://vscode-remote/wsl+Ubuntu/home/me/repo",
    );
  });
});

describe("opening the vault (REQ-2.0.8, 2.0.9)", () => {
  const wsl = { distro: "Ubuntu", automountRoot: "/mnt/" };

  it("builds Obsidian's open link from the note's path, as Windows sees it from WSL", () => {
    expect(obsidianOpenUri("/home/me/Vault/P/P.md", null)).toBe(
      "obsidian://open?path=%2Fhome%2Fme%2FVault%2FP%2FP.md",
    );
    expect(obsidianOpenUri("/mnt/c/Vault/P/P.md", wsl)).toBe(
      `obsidian://open?path=${encodeURIComponent("C:\\Vault\\P\\P.md")}`,
    );
  });

  it("turns deep links on and off, adding the note's uid and leaving it when turned off (REQ-2.6, 2.7)", async () => {
    const id = newProjectId();
    const note = path.join(vault, "P", "P.md");
    const committed = committedRecord({
      projectId: id,
      docsFolder: "docs",
      vaultFolder: "P",
      settings: DEFAULT_SETTINGS,
    });
    const local = localRecord({
      projectId: id,
      vaultRoot: vault,
      vaultFolderPath: path.join(vault, "P"),
      linkNotePath: note,
    });
    await writeLink(repo, committed, local);
    await writeLinkNote(note, {
      projectId: id,
      repoPath: repo,
      openRepoUri: "vscode://file/x",
      deepLinks: false,
    });
    const before = await readFile(note, "utf8");

    const on = await setDeepLinks(repo, committed, local, true);
    expect(on.deepLink).toBe(deepLinkFor(id));
    const saved = JSON.parse(await readFile(path.join(repo, COMMITTED_FILE), "utf8")) as unknown;
    expect(saved).toMatchObject({
      deepLink: deepLinkFor(id),
      settings: { advancedUriDeepLinks: true },
    });
    expect(JSON.stringify(saved)).not.toContain("Private Vault");
    expect(await readFile(note, "utf8")).toContain(`uid: ${id}`);

    expect(await readLinkNoteUid(note)).toBe(id);

    const off = await setDeepLinks(repo, on, local, false);
    expect(off.deepLink).toBeUndefined();
    expect(
      JSON.stringify(JSON.parse(await readFile(path.join(repo, COMMITTED_FILE), "utf8"))),
    ).not.toContain("adv-uri");
    // The uid stays: it's harmless, and the user may have added it by hand (design decision 18).
    expect(await readLinkNoteUid(note)).toBe(id);
    expect(await readFile(note, "utf8")).not.toBe(before);
  });

  it("adds a uid to a link note without touching anything else, and reads it back", async () => {
    const note = path.join(vault, "Q", "Q.md");
    await mkdir(path.dirname(note), { recursive: true });
    await writeFile(note, "---\ntitle: Q\n---\nBody\n");
    expect(await readLinkNoteUid(note)).toBeNull();
    await setLinkNoteUid(note, "pd_x");
    expect(await readFile(note, "utf8")).toBe("---\ntitle: Q\nuid: pd_x\n---\nBody\n");
    expect(await readLinkNoteUid(note)).toBe("pd_x");
    await setLinkNoteUid(path.join(vault, "missing.md"), "pd_x");
    expect(await readLinkNoteUid(path.join(vault, "missing.md"))).toBeNull();
  });
});
