/**
 * The engine: opens a linked project and runs sync passes. Shared by the CLI (one pass, then exit)
 * and the VS Code extension (a long-lived controller that holds the lock and runs passes as files
 * change), so both apply exactly the same rules and safeguards (REQ-18.0.1).
 */
import { opendir, readFile } from "node:fs/promises";
import * as path from "node:path";
import { execute, replayJournal, type PassResult } from "../exec/index.js";
import {
  INVALID_PRIVATE_FILES,
  parsePrivateFilesList,
  type PrivateFilesList,
} from "../guards/index.js";
import { createResolver } from "../links/index.js";
import {
  acquireLock,
  isLockHandle,
  type LockHandle,
  type LockInfo,
  type LockOwner,
} from "../lock/index.js";
import { createFileLogger, type Logger } from "../log/index.js";
import { detectWsl, isWindowsFs, probeCaseInsensitive, toKey } from "../paths/index.js";
import { plan, type Plan } from "../plan/index.js";
import { PrivateMdError, loadPlaceholders, type PrivateMdMapping } from "../privatemd/index.js";
import { COMMITTED_FILE, readLink, type CommittedLink, type LocalLink } from "../records/index.js";
import { decodeUtf8, scan, type StatCache } from "../scan/index.js";
import { createNodeSideFs, vaultTrash, type SideFs, type TrashFn } from "../sidefs/index.js";
import { StateStore, projectStateDir, stateRoot } from "../state/index.js";

/** A linked project, ready to sync. */
export interface Project {
  readonly repoRoot: string;
  readonly committed: CommittedLink;
  readonly local: LocalLink;
  readonly repo: SideFs;
  readonly vault: SideFs;
  readonly store: StateStore;
  readonly logger: Logger;
  /** The link note's key inside the vault folder, when it's there. */
  readonly linkNoteKey: string | undefined;
  /** The latest PRIVATE.md mapping, refreshed each pass; the logger redacts with it. */
  readonly privateMd: { current: PrivateMdMapping | null };
}

/** Why a project couldn't be opened. */
export type OpenProblem =
  | { readonly problem: "not-linked"; readonly message: string }
  | { readonly problem: "relink"; readonly message: string; readonly committed: CommittedLink }
  | { readonly problem: "invalid"; readonly message: string };

/** Options for opening a project. */
export interface OpenOptions {
  /** How the repo side's deleted files reach the trash (VS Code's API, or the `trash` package). */
  readonly repoTrash: TrashFn;
  /** The state root, normally the per-user app-data folder. */
  readonly stateRoot?: string;
}

/** Walks up from `start` to the folder holding `.project-docs.json`, if any. */
export async function findRepoRoot(start: string): Promise<string | null> {
  let current = path.resolve(start);
  for (;;) {
    try {
      await readFile(path.join(current, COMMITTED_FILE));
      return current;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  }
}

/** Opens the linked project whose repo root is `repoRoot`. */
export async function openProject(
  repoRoot: string,
  options: OpenOptions,
): Promise<Project | OpenProblem> {
  const link = await readLink(repoRoot);
  if (link.state === "unlinked") {
    return { problem: "not-linked", message: `${repoRoot} isn't linked to an Obsidian vault` };
  }
  if (link.state === "invalid") {
    return { problem: "invalid", message: `${link.file}: ${link.problems.join("; ")}` };
  }
  if (link.state === "relink") {
    return {
      problem: "relink",
      committed: link.committed,
      message: `${repoRoot} is linked, but this machine doesn't know where the vault is; link it again to ${link.committed.vaultFolder}`,
    };
  }
  const { committed, local } = link;
  const wsl = detectWsl();
  const docsRoot = path.join(repoRoot, ...committed.docsFolder.split("/").filter(Boolean));
  const [repoInsensitive, vaultInsensitive] = await Promise.all([
    probeCaseInsensitive(repoRoot),
    probeCaseInsensitive(local.vaultFolderPath),
  ]);
  const store = new StateStore(
    projectStateDir(committed.projectId, options.stateRoot ?? stateRoot()),
    committed.projectId,
  );
  const privateMd: { current: PrivateMdMapping | null } = { current: null };
  const relativeNote = path.relative(local.vaultFolderPath, local.linkNotePath);
  return {
    repoRoot,
    committed,
    local,
    repo: createNodeSideFs({
      side: "repo",
      root: docsRoot,
      isWindowsFs: isWindowsFs(docsRoot, process.platform, wsl),
      caseInsensitive: repoInsensitive,
      trash: options.repoTrash,
    }),
    vault: createNodeSideFs({
      side: "vault",
      root: local.vaultFolderPath,
      isWindowsFs: isWindowsFs(local.vaultFolderPath, process.platform, wsl),
      caseInsensitive: vaultInsensitive,
      trash: vaultTrash(local.vaultRoot),
    }),
    store,
    logger: createFileLogger({
      dir: path.join(store.dir, "log"),
      mapping: () => privateMd.current,
    }),
    linkNoteKey:
      relativeNote.startsWith("..") || path.isAbsolute(relativeNote)
        ? undefined
        : toKey(relativeNote),
    privateMd,
  };
}

/** Reads PRIVATE.md, or explains why real-value protection is off this pass. */
export async function loadMapping(
  repoRoot: string,
): Promise<{ mapping: PrivateMdMapping | null; problem?: string }> {
  try {
    return { mapping: await loadPlaceholders(path.join(repoRoot, "PRIVATE.md")) };
  } catch (error) {
    if (error instanceof PrivateMdError) {
      if (error.kind === "missing-file") return { mapping: null };
      return {
        mapping: null,
        problem: `PRIVATE.md can't be read (${error.message}), so real values aren't being checked`,
      };
    }
    throw error;
  }
}

async function loadPrivateFiles(
  vaultFolderPath: string,
): Promise<PrivateFilesList | typeof INVALID_PRIVATE_FILES> {
  try {
    return parsePrivateFilesList(
      await readFile(path.join(vaultFolderPath, ".project-docs", "private-files.json"), "utf8"),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return parsePrivateFilesList(null);
    return INVALID_PRIVATE_FILES;
  }
}

/** Every file in the vault, vault-relative, for resolving links (names only; nothing is read). */
async function listVault(vaultRoot: string): Promise<string[]> {
  const files: string[] = [];
  async function walk(folder: string, prefix: string): Promise<void> {
    let dir;
    try {
      dir = await opendir(folder);
    } catch {
      return;
    }
    for await (const entry of dir) {
      if (entry.name === ".obsidian" || entry.name === ".trash" || entry.name === ".git") continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(path.join(folder, entry.name), rel);
      else if (entry.isFile()) files.push(rel);
    }
  }
  await walk(vaultRoot, "");
  return files;
}

/** Plans a pass for a project without changing anything. */
export async function planPass(
  project: Project,
  cache?: { repo: StatCache; vault: StatCache },
): Promise<{ plan: Plan; problems: string[] }> {
  const { committed, local } = project;
  const problems: string[] = [];
  const { mapping, problem } = await loadMapping(project.repoRoot);
  project.privateMd.current = mapping;
  if (problem) problems.push(problem);
  const { index } = await project.store.loadIndex();
  const includeAttachments = committed.settings.syncAttachments;
  const [repo, vault, privateFiles, vaultFiles] = await Promise.all([
    scan(project.repo, { includeAttachments, cache: cache?.repo }),
    scan(project.vault, {
      includeAttachments,
      linkNoteKey: project.linkNoteKey,
      cache: cache?.vault,
    }),
    loadPrivateFiles(local.vaultFolderPath),
    listVault(local.vaultRoot),
  ]);
  const readText = async (side: "repo" | "vault", key: string) => {
    const fs = side === "repo" ? project.repo : project.vault;
    return (await fs.exists(key)) ? decodeUtf8(await fs.read(key)) : null;
  };
  const planned = await plan({
    repo,
    vault,
    index,
    settings: committed.settings,
    repoTraits: {
      isWindowsFs: project.repo.isWindowsFs,
      caseInsensitive: project.repo.caseInsensitive,
    },
    vaultTraits: {
      isWindowsFs: project.vault.isWindowsFs,
      caseInsensitive: project.vault.caseInsensitive,
    },
    linkNoteKey: project.linkNoteKey,
    privateFiles,
    mapping,
    resolver: createResolver({ projectFolder: committed.vaultFolder, files: vaultFiles }),
    readText,
    readBase: async (hash) => {
      const blob = await project.store.getBlob(hash);
      return blob ? decodeUtf8(blob) : null;
    },
  });
  return { plan: planned, problems };
}

/** The outcome of asking for a sync pass. */
export type SyncOutcome =
  | {
      readonly outcome: "synced";
      readonly result: PassResult;
      readonly plan: Plan;
      readonly problems: readonly string[];
    }
  /** The bulk guard stopped the pass (REQ-7); nothing changed. */
  | { readonly outcome: "bulk"; readonly plan: Plan }
  /** Another engine holds the lock (REQ-18.0.2). */
  | { readonly outcome: "locked"; readonly heldBy: LockInfo | null };

/** Options for one sync pass. */
export interface SyncOptions {
  /** Proceed past the bulk guard (the CLI's `--yes`, or the user's "Proceed"). */
  readonly allowBulk?: boolean;
  /** A lock already held by the caller (the extension holds one for its lifetime). */
  readonly lock?: LockHandle;
  readonly owner?: LockOwner;
  readonly window?: string;
  readonly cache?: { repo: StatCache; vault: StatCache };
}

/** Runs one sync pass: lock, replay, plan, bulk guard, execute. */
export async function syncOnce(project: Project, options: SyncOptions = {}): Promise<SyncOutcome> {
  let lock = options.lock;
  let ownLock = false;
  if (!lock) {
    await project.store.ensure();
    const acquired = await acquireLock(project.store.dir, options.owner ?? "cli", {
      window: options.window,
    });
    if (!isLockHandle(acquired)) return { outcome: "locked", heldBy: acquired.heldBy };
    lock = acquired;
    ownLock = true;
  }
  try {
    const ctx = {
      repo: project.repo,
      vault: project.vault,
      store: project.store,
      logger: project.logger,
    };
    const { index } = await project.store.loadIndex();
    const replayed = await replayJournal(ctx, index);
    const { plan: planned, problems } = await planPass(project, options.cache);
    if (planned.bulk.guarded && !options.allowBulk) {
      await project.store.savePendingBulk({
        bulk: planned.bulk,
        plannedAt: new Date().toISOString(),
      });
      return { outcome: "bulk", plan: planned };
    }
    await project.store.clearPendingBulk();
    const result = await execute(
      planned,
      ctx,
      replayed?.index ?? (await project.store.loadIndex()).index,
    );
    return { outcome: "synced", result, plan: planned, problems };
  } finally {
    if (ownLock) await lock.release();
  }
}
