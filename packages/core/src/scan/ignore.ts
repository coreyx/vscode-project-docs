/**
 * The repo's ignore rules (REQ-3.0.7, design decision 20): what git ignores, minus the link's
 * `syncIgnored` exceptions, plus `node_modules` always. Every key is judged by its path in the
 * repo, whichever side it's on, so a file is skipped on both sides or on neither. A rule applied to
 * one side alone would make the planner trash the other copy as a deletion.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import * as path from "node:path";
import ignore, { type Ignore } from "ignore";

/** A folder that's never synced, wherever it is and whatever `syncIgnored` says. */
export const ALWAYS_IGNORED_FOLDER = "node_modules";

/** Folders the loader never enters looking for `.gitignore` files; the scanner skips them too. */
const NOT_SEARCHED = new Set([
  ".git",
  ".project-docs",
  ".obsidian",
  ".trash",
  ALWAYS_IGNORED_FOLDER,
]);

/** One file of rules, applying to paths below `base` (repo-relative, `""` for the root). */
interface Level {
  readonly base: string;
  readonly rules: Ignore;
}

/** What the scanner and planner ask of the rules. Keys are relative to the docs folder. */
export interface IgnoreRules {
  /** True when sync skips this file, or this folder and everything in it. */
  skips(key: string, folder: boolean): boolean;
  /** True when git ignores it, whether or not `syncIgnored` brings it back. */
  gitIgnores(key: string, folder: boolean): boolean;
  /** True when sync can skip the whole folder without looking inside it. */
  skipsFolder(key: string): boolean;
}

/** A rule file that couldn't be read: sync must not run, or an ignored folder could be copied. */
export interface UnreadableRules {
  /** The file's path relative to the repo root, with `/` separators. */
  readonly file: string;
  readonly message: string;
}

/** True when a key lies in a `node_modules` folder, or is one. */
export function inNodeModules(key: string): boolean {
  return key.split("/").includes(ALWAYS_IGNORED_FOLDER);
}

/** Reads a rule file; null when it doesn't exist. Any other failure is thrown. */
async function readRules(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw error;
  }
}

/**
 * The folder holding git's own files for the repo, where `info/exclude` is. In a worktree or a
 * submodule `.git` is a file naming that folder, and a worktree shares `info/` with the main one.
 */
async function gitDir(repoRoot: string): Promise<string | null> {
  const dotGit = path.join(repoRoot, ".git");
  const info = await stat(dotGit).catch(() => null);
  if (!info) return null;
  if (info.isDirectory()) return dotGit;
  const pointer = /^gitdir:\s*(.+?)\s*$/m.exec((await readRules(dotGit)) ?? "");
  if (!pointer?.[1]) return null;
  const dir = path.resolve(repoRoot, pointer[1]);
  const common = (await readRules(path.join(dir, "commondir")))?.trim();
  return common ? path.resolve(dir, common) : dir;
}

/** Joins repo-relative path parts, leaving out empty ones. */
function join(...parts: string[]): string {
  return parts.filter(Boolean).join("/");
}

/** Builds the matcher from the levels found, the docs folder and the exceptions. */
function matcher(
  levels: readonly Level[],
  docsFolder: string,
  syncIgnored: Ignore,
  exceptions: readonly string[],
): IgnoreRules {
  /** Git's verdict on one path, without looking at its parents: the deepest rule that matches wins. */
  const verdict = (repoPath: string, folder: boolean): boolean => {
    let ignored = false;
    for (const level of levels) {
      if (level.base && !repoPath.startsWith(`${level.base}/`)) continue;
      const relative = level.base ? repoPath.slice(level.base.length + 1) : repoPath;
      const result = level.rules.test(folder ? `${relative}/` : relative);
      if (result.ignored) ignored = true;
      else if (result.unignored) ignored = false;
    }
    return ignored;
  };
  /** Git's verdict with its parents: nothing inside an ignored folder can be brought back. */
  const gitIgnoresRepoPath = (repoPath: string, folder: boolean): boolean => {
    const parts = repoPath.split("/");
    for (let i = 1; i < parts.length; i++) {
      if (verdict(parts.slice(0, i).join("/"), true)) return true;
    }
    return verdict(repoPath, folder);
  };
  const gitIgnores = (key: string, folder: boolean) =>
    gitIgnoresRepoPath(join(docsFolder, key), folder);
  const excepted = (key: string, folder: boolean) =>
    exceptions.length > 0 && syncIgnored.test(folder ? `${key}/` : key).ignored;
  const skips = (key: string, folder: boolean) =>
    inNodeModules(key) || (gitIgnores(key, folder) && !excepted(key, folder));
  return {
    skips,
    gitIgnores,
    skipsFolder: (key) =>
      skips(key, true) && (inNodeModules(key) || !mayHoldExceptions(key, exceptions)),
  };
}

/**
 * True when a `syncIgnored` pattern could match something inside `folder`, so an ignored folder
 * must still be walked. Conservative: a pattern that can match at any depth always could.
 */
function mayHoldExceptions(folder: string, exceptions: readonly string[]): boolean {
  const inside = `${folder}/`;
  return exceptions.some((raw) => {
    const pattern = raw.replace(/^!/, "").replace(/^\//, "");
    const anchored =
      pattern.replace(/\/$/, "").includes("/") || raw.replace(/^!/, "").startsWith("/");
    if (!anchored) return true;
    const literal = pattern.split(/[*?[]/)[0] ?? "";
    return inside.startsWith(literal) || literal.startsWith(inside);
  });
}

/**
 * Loads the ignore rules for a link: `.git/info/exclude`, every `.gitignore` from the repo root down
 * to the docs folder, and every one inside it, skipping folders that are already ignored. Returns
 * the rule file that couldn't be read instead, if any.
 */
export async function loadIgnoreRules(
  repoRoot: string,
  docsFolder: string,
  syncIgnored: readonly string[],
): Promise<{ rules: IgnoreRules } | { unreadable: UnreadableRules }> {
  const levels: Level[] = [];
  let current = "";
  const add = async (base: string, file: string) => {
    current = path.relative(repoRoot, file).split(path.sep).join("/");
    const text = await readRules(file);
    if (text !== null) levels.push({ base, rules: ignore().add(text) });
  };
  const exceptions = syncIgnored.filter((p) => p.trim() !== "" && !p.trim().startsWith("#"));
  const exceptionRules = ignore().add(exceptions);
  const docs = docsFolder.split("/").filter(Boolean).join("/");
  try {
    current = ".git";
    const git = await gitDir(repoRoot);
    if (git) await add("", path.join(git, "info", "exclude"));
    // The levels from the root down to the docs folder, then the docs folder's own tree.
    const segments = docs ? docs.split("/") : [];
    for (let i = 0; i <= segments.length; i++) {
      const base = segments.slice(0, i).join("/");
      await add(base, path.join(repoRoot, ...segments.slice(0, i), ".gitignore"));
    }
    const rules = () => matcher(levels, docs, exceptionRules, exceptions);
    const walk = async (key: string): Promise<void> => {
      const folder = path.join(
        repoRoot,
        ...docs.split("/").filter(Boolean),
        ...key.split("/").filter(Boolean),
      );
      let entries;
      try {
        entries = await readdir(folder, { withFileTypes: true });
      } catch {
        // A folder that vanished or can't be listed is the scanner's to report.
        return;
      }
      for (const entry of entries) {
        // Symbolic links aren't followed (REQ-16.0.5), so rules behind one never apply.
        if (!entry.isDirectory() || NOT_SEARCHED.has(entry.name)) continue;
        const child = join(key, entry.name);
        if (rules().skipsFolder(child)) continue;
        await add(join(docs, child), path.join(folder, entry.name, ".gitignore"));
        await walk(child);
      }
    };
    await walk("");
  } catch (error) {
    return {
      unreadable: {
        file: current,
        message: `${current} can't be read (${(error as Error).message}), so Project Docs can't tell which files git ignores, and isn't syncing`,
      },
    };
  }
  return { rules: matcher(levels, docs, exceptionRules, exceptions) };
}

/** True when a folder holds a Markdown file somewhere inside, without following symbolic links. */
async function holdsMarkdown(folder: string): Promise<boolean> {
  const entries = await readdir(folder, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) return true;
  }
  for (const entry of entries) {
    if (entry.isDirectory() && !NOT_SEARCHED.has(entry.name)) {
      if (await holdsMarkdown(path.join(folder, entry.name))) return true;
    }
  }
  return false;
}

/**
 * The folders inside the docs folder that git ignores and that hold notes, other than
 * `node_modules`, by key, for the question asked when linking (REQ-1.0.6). Only the outermost
 * ignored folder of each branch is listed, since bringing it back brings back what's inside.
 * Returns none when the rules can't be read: the first sync then stops and reports the file.
 */
export async function findIgnoredNoteFolders(
  repoRoot: string,
  docsFolder: string,
): Promise<string[]> {
  const loaded = await loadIgnoreRules(repoRoot, docsFolder, []);
  if ("unreadable" in loaded) return [];
  const { rules } = loaded;
  const docs = path.join(repoRoot, ...docsFolder.split("/").filter(Boolean));
  const found: string[] = [];
  const walk = async (key: string): Promise<void> => {
    const folder = path.join(docs, ...key.split("/").filter(Boolean));
    const entries = await readdir(folder, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (!entry.isDirectory() || NOT_SEARCHED.has(entry.name)) continue;
      const child = join(key, entry.name);
      if (!rules.gitIgnores(child, true)) await walk(child);
      else if (await holdsMarkdown(path.join(folder, entry.name))) found.push(child);
    }
  };
  await walk("");
  return found;
}
