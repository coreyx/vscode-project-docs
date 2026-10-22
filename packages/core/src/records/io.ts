/**
 * Reading and writing the link records, keeping the machine-local one out of git, and writing the
 * link note into the vault (REQ-2).
 */
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { wslToWindows, type WslContext } from "../paths/index.js";
import { readProperty, removeProperties, setProperties } from "../rules/index.js";
import { writeFileAtomic } from "../sidefs/index.js";
import {
  COMMITTED_DESCRIPTION,
  COMMITTED_FILE,
  LOCAL_DESCRIPTION,
  LOCAL_FILE,
  RECORD_FORMAT,
  type CommittedLink,
  type LinkSettingsRecord,
  type LinkState,
  type LocalLink,
} from "./types.js";
import { validateCommitted, validateLocal } from "./validate.js";

/** A new project id: `pd_` and a random UUID. */
export function newProjectId(): string {
  return `pd_${randomUUID()}`;
}

/** The Advanced URI deep link that opens a project's link note by its `uid` (REQ-2.0.8). */
export function deepLinkFor(projectId: string): string {
  return `obsidian://adv-uri?uid=${encodeURIComponent(projectId)}`;
}

async function readJson(file: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return null;
  }
}

/** Reads a repo's link records and says what state the link is in. */
export async function readLink(repoRoot: string): Promise<LinkState> {
  const committedFile = path.join(repoRoot, COMMITTED_FILE);
  const raw = await readJson(committedFile);
  if (raw === undefined) return { state: "unlinked" };
  const committed = validateCommitted(raw);
  if ("problems" in committed)
    return { state: "invalid", file: committedFile, problems: committed.problems };
  const localRaw = await readJson(path.join(repoRoot, LOCAL_FILE));
  if (localRaw === undefined || localRaw === null) return { state: "relink", committed };
  const local = validateLocal(localRaw);
  // A local record for a different project belongs to an old link; treat it as missing.
  if ("problems" in local || local.projectId !== committed.projectId)
    return { state: "relink", committed };
  return { state: "linked", committed, local };
}

/** Builds the committed record, adding the deep link only while the setting is on. */
export function committedRecord(fields: {
  projectId: string;
  docsFolder: string;
  vaultFolder: string;
  settings: LinkSettingsRecord;
}): CommittedLink {
  return {
    format: RECORD_FORMAT,
    description: COMMITTED_DESCRIPTION,
    projectId: fields.projectId,
    docsFolder: fields.docsFolder.replace(/\\/g, "/"),
    vaultFolder: fields.vaultFolder.replace(/\\/g, "/"),
    settings: fields.settings,
    ...(fields.settings.advancedUriDeepLinks ? { deepLink: deepLinkFor(fields.projectId) } : {}),
  };
}

/** Builds the machine-local record. */
export function localRecord(fields: Omit<LocalLink, "format" | "description">): LocalLink {
  return { format: RECORD_FORMAT, description: LOCAL_DESCRIPTION, ...fields };
}

/** Thrown when a committed record would publish something it mustn't. */
export class UnsafeRecordError extends Error {
  constructor(problems: readonly string[]) {
    super(`The committed link record can't be written: ${problems.join("; ")}`);
    this.name = "UnsafeRecordError";
  }
}

/**
 * Writes both records, refusing a committed record that fails validation (such as one containing
 * an absolute path), and makes sure git ignores the local one (REQ-2.0.6).
 */
export async function writeLink(
  repoRoot: string,
  committed: CommittedLink,
  local: LocalLink,
): Promise<void> {
  const checked = validateCommitted(committed);
  if ("problems" in checked) throw new UnsafeRecordError(checked.problems);
  await writeFileAtomic(
    path.join(repoRoot, COMMITTED_FILE),
    `${JSON.stringify(committed, null, 2)}\n`,
  );
  await writeFileAtomic(path.join(repoRoot, LOCAL_FILE), `${JSON.stringify(local, null, 2)}\n`);
  await ensureGitIgnored(repoRoot, LOCAL_FILE);
}

/**
 * Adds `name` to the repo's `.gitignore` unless git already ignores it. Asks git when it's
 * available, so an ignore rule elsewhere (a global excludes file, a parent `.gitignore`) counts.
 */
export async function ensureGitIgnored(repoRoot: string, name: string): Promise<void> {
  const check = spawnSync("git", ["check-ignore", "-q", name], { cwd: repoRoot });
  if (check.status === 0) return;
  const gitignore = path.join(repoRoot, ".gitignore");
  let existing = "";
  try {
    existing = await readFile(gitignore, "utf8");
  } catch {
    // No .gitignore yet.
  }
  if (existing.split(/\r?\n/).some((line) => line.trim() === name || line.trim() === `/${name}`))
    return;
  const eol = existing.includes("\r\n") ? "\r\n" : "\n";
  const separator = existing === "" || existing.endsWith("\n") ? "" : eol;
  await writeFileAtomic(gitignore, `${existing}${separator}${name}${eol}`);
}

/** Resolves the link note's absolute path from the folder-note pattern (REQ-2.0.2). */
export function linkNotePathFor(vaultFolderPath: string, pattern: string): string {
  const folderName = path.basename(vaultFolderPath);
  const relative = pattern.replace(/\{folder\}\/?/g, "").replace(/\{folderName\}/g, folderName);
  return path.join(vaultFolderPath, ...relative.split("/").filter(Boolean));
}

/**
 * The repo's path in the form the vault side opens (REQ-2.0.4): when the engine runs in WSL and the
 * vault is on Windows, the Windows plugin needs `\\wsl.localhost\<distro>\…`.
 */
export function repoPathForVault(
  repoRoot: string,
  wsl: WslContext | null,
  vaultOnWindows: boolean,
): string {
  return wsl && vaultOnWindows ? wslToWindows(repoRoot, wsl) : repoRoot;
}

/** A link that opens the repo in VS Code, from a WSL distro when the repo lives there. */
export function vscodeOpenUri(repoRoot: string, wsl: WslContext | null): string {
  const unified = repoRoot.replace(/\\/g, "/");
  if (wsl)
    return `vscode://vscode-remote/wsl+${encodeURIComponent(wsl.distro)}${encodeURI(unified)}`;
  return `vscode://file/${encodeURI(unified.replace(/^\//, ""))}`;
}

const OPEN_REPO_LABEL = "Open the repo in VS Code";

/**
 * Writes the link properties into the link note, creating it if needed, and adds the "open repo"
 * link once. The note's other content is kept as it is (REQ-2.8).
 */
export async function writeLinkNote(
  linkNotePath: string,
  fields: { projectId: string; repoPath: string; openRepoUri: string; deepLinks: boolean },
): Promise<void> {
  let text = "";
  try {
    text = await readFile(linkNotePath, "utf8");
  } catch {
    // A new note.
  }
  const properties: Record<string, string> = {
    "project-docs-id": fields.projectId,
    "project-docs-repo": fields.repoPath,
  };
  // The uid is what Advanced URI deep links look up; it's written only with the setting on.
  if (fields.deepLinks) properties["uid"] = fields.projectId;
  text = setProperties(text, properties);
  if (!text.includes(`[${OPEN_REPO_LABEL}](`)) {
    const eol = text.includes("\r\n") ? "\r\n" : "\n";
    const separator = text.endsWith("\n") ? "" : eol;
    text += `${separator}${eol}[${OPEN_REPO_LABEL}](${fields.openRepoUri})${eol}`;
  }
  await writeFileAtomic(linkNotePath, text);
}

/**
 * Obsidian's built-in link to a note by its full path (REQ-2.0.9). From WSL, Obsidian is a Windows
 * program, so the path is given as Windows sees it. Built from the machine-local record each time
 * and never written anywhere committed.
 */
export function obsidianOpenUri(notePath: string, wsl: WslContext | null): string {
  const native = wsl ? wslToWindows(notePath, wsl) : notePath;
  return `obsidian://open?path=${encodeURIComponent(native)}`;
}

/**
 * Turns Advanced URI deep links on or off for a linked repo (REQ-2.0.8): the committed record
 * gains or loses its deep link, and the link note its `uid`. Returns the new committed record.
 */
export async function setDeepLinks(
  repoRoot: string,
  committed: CommittedLink,
  local: LocalLink,
  on: boolean,
): Promise<CommittedLink> {
  const updated = committedRecord({
    projectId: committed.projectId,
    docsFolder: committed.docsFolder,
    vaultFolder: committed.vaultFolder,
    settings: { ...committed.settings, advancedUriDeepLinks: on },
  });
  await writeLink(repoRoot, updated, local);
  let note: string;
  try {
    note = await readFile(local.linkNotePath, "utf8");
  } catch {
    // No link note to update; it's written again on the next link.
    return updated;
  }
  const next = on
    ? setProperties(note, { uid: committed.projectId })
    : removeProperties(note, ["uid"]);
  if (next !== note) await writeFileAtomic(local.linkNotePath, next);
  return updated;
}

/** Reads the repo path recorded in a link note, as the plugin does (REQ-14.0.6). */
export async function readLinkNoteRepo(linkNotePath: string): Promise<string | null> {
  try {
    const value = readProperty(await readFile(linkNotePath, "utf8"), "project-docs-repo");
    return value.kind === "scalar" && typeof value.value === "string" ? value.value : null;
  } catch {
    return null;
  }
}
