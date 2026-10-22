/**
 * Creating and removing links (REQ-1, REQ-2). Plain Node, no VS Code: the link command supplies
 * the answers to its prompts, and tests can drive this directly.
 */
import { mkdir, readFile, realpath, rm } from "node:fs/promises";
import * as path from "node:path";
import {
  COMMITTED_FILE,
  DEFAULT_SETTINGS,
  LOCAL_FILE,
  committedRecord,
  detectWsl,
  isWindowsFs,
  linkNotePathFor,
  localRecord,
  newProjectId,
  readLink,
  removeProperties,
  repoPathForVault,
  vscodeOpenUri,
  writeFileAtomic,
  writeLink,
  writeLinkNote,
  type CommittedLink,
  type LinkSettingsRecord,
  type LocalLink,
  type WslContext,
} from "@specdevship/project-docs-core";

/** What linking needs to know. */
export interface LinkRequest {
  readonly repoRoot: string;
  /** Relative to the repo root. */
  readonly docsFolder: string;
  /** Absolute. */
  readonly vaultRoot: string;
  /** Relative to the vault root. */
  readonly vaultFolder: string;
  /** Kept when re-linking, so the engine's state and the link note carry over (REQ-2.5). */
  readonly projectId?: string | undefined;
  readonly settings?: LinkSettingsRecord | undefined;
}

/** Thrown when a link can't be created; the message is for the user. */
export class LinkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LinkError";
  }
}

/** Resolves symlinks for a path that may not exist yet, through its nearest existing parent. */
async function resolveReal(target: string): Promise<string> {
  const missing: string[] = [];
  let current = path.resolve(target);
  for (;;) {
    try {
      return path.join(await realpath(current), ...missing.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(target);
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

function contains(outer: string, inner: string): boolean {
  // Windows and macOS compare names without regard to case by default.
  const fold = (p: string) =>
    process.platform === "win32" || process.platform === "darwin" ? p.toLowerCase() : p;
  const relative = path.relative(fold(outer), fold(inner));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Refuses a link that could make sync feed itself: a vault folder inside the repo, or a docs
 * folder inside the vault (REQ-1.0.4). Compares real paths, so a symlink can't hide the nesting.
 */
export async function checkNesting(
  repoRoot: string,
  docsPath: string,
  vaultRoot: string,
  vaultFolderPath: string,
): Promise<string | null> {
  const [repo, docs, vault, vaultFolder] = await Promise.all(
    [repoRoot, docsPath, vaultRoot, vaultFolderPath].map(resolveReal),
  );
  if (contains(repo ?? "", vaultFolder ?? "")) {
    return "The vault folder is inside the repo, so sync would copy its own copies. Choose a vault folder outside the repo.";
  }
  if (contains(vault ?? "", docs ?? "")) {
    return "The docs folder is inside the vault, so sync would copy its own copies. Choose a docs folder outside the vault.";
  }
  return null;
}

/** Validates a folder typed relative to a root. */
function relativeFolder(value: string, what: string): string {
  const unified = value
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\/|\/+$/g, "");
  if (
    unified === "" ||
    unified.startsWith("/") ||
    /^[A-Za-z]:/.test(unified) ||
    unified.split("/").includes("..")
  ) {
    throw new LinkError(`The ${what} must be a folder inside its root, like "docs".`);
  }
  return unified;
}

/** Creates the link: both records, the vault folder, and the link note (REQ-1.0.1, REQ-2). */
export async function createLink(
  request: LinkRequest,
  wsl: WslContext | null = detectWsl(),
): Promise<{ committed: CommittedLink; local: LocalLink }> {
  const docsFolder = relativeFolder(request.docsFolder, "docs folder");
  const vaultFolder = relativeFolder(request.vaultFolder, "vault folder");
  const docsPath = path.join(request.repoRoot, ...docsFolder.split("/"));
  const vaultFolderPath = path.join(request.vaultRoot, ...vaultFolder.split("/"));
  const nesting = await checkNesting(
    request.repoRoot,
    docsPath,
    request.vaultRoot,
    vaultFolderPath,
  );
  if (nesting) throw new LinkError(nesting);

  const settings = request.settings ?? DEFAULT_SETTINGS;
  const projectId = request.projectId ?? newProjectId();
  const linkNotePath = linkNotePathFor(vaultFolderPath, settings.folderNotePattern);
  const committed = committedRecord({ projectId, docsFolder, vaultFolder, settings });
  const local = localRecord({
    projectId,
    vaultRoot: request.vaultRoot,
    vaultFolderPath,
    linkNotePath,
  });

  await mkdir(docsPath, { recursive: true });
  await mkdir(vaultFolderPath, { recursive: true });
  await writeLink(request.repoRoot, committed, local);
  await writeLinkNote(linkNotePath, {
    projectId,
    repoPath: repoPathForVault(
      request.repoRoot,
      wsl,
      isWindowsFs(request.vaultRoot, process.platform, wsl),
    ),
    openRepoUri: vscodeOpenUri(request.repoRoot, wsl),
    deepLinks: settings.advancedUriDeepLinks,
  });
  return { committed, local };
}

/** The link properties written into the link note. */
const LINK_NOTE_PROPERTIES = ["project-docs-id", "project-docs-repo", "uid"];

/**
 * Removes the link: both records, and the link properties from the link note. Every other file
 * stays exactly where it is (REQ-1.0.5).
 */
export async function removeLink(repoRoot: string): Promise<void> {
  const state = await readLink(repoRoot);
  if (state.state === "linked") {
    try {
      const note = await readFile(state.local.linkNotePath, "utf8");
      await writeFileAtomic(state.local.linkNotePath, removeProperties(note, LINK_NOTE_PROPERTIES));
    } catch {
      // The note is gone or unreadable; there's nothing to take the properties out of.
    }
  }
  await rm(path.join(repoRoot, COMMITTED_FILE), { force: true });
  await rm(path.join(repoRoot, LOCAL_FILE), { force: true });
}
