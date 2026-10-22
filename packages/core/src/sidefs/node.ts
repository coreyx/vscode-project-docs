/**
 * The Node implementation of `SideFs`, used by the extension and the CLI.
 */
import { randomBytes } from "node:crypto";
import { lstat, mkdir, open, opendir, readFile, rename, unlink } from "node:fs/promises";
import * as path from "node:path";
import { absoluteFromKey, isCaseOnlyChange, toKey } from "../paths/index.js";
import type { FileEntry, Side, SideFs, TrashFn } from "./types.js";

/** Marker in the names of the engine's temporary files, which the scanner always ignores. */
export const TEMP_MARKER = ".pd-tmp-";

/** True for a file name the engine created as a temporary step of a write or rename. */
export function isTempName(name: string): boolean {
  return name.includes(TEMP_MARKER);
}

/** Options for `createNodeSideFs`. */
export interface NodeSideFsOptions {
  readonly side: Side;
  readonly root: string;
  readonly isWindowsFs: boolean;
  readonly caseInsensitive: boolean;
  readonly trash: TrashFn;
}

// Windows refuses to replace or remove a file that another process (an editor, an indexer, a
// virus scanner, Obsidian reading it) has open without delete sharing. Those errors clear within
// moments, so the operation is retried briefly before giving up.
const RETRYABLE = new Set(["EPERM", "EBUSY", "EACCES"]);
const RETRY_DELAYS_MS = [10, 25, 50, 100, 200, 400, 800];

async function withRetries<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "";
      const delay = RETRY_DELAYS_MS[attempt];
      if (!RETRYABLE.has(code) || delay === undefined) throw error;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

function tempPathFor(target: string): string {
  return path.join(
    path.dirname(target),
    `.${path.basename(target)}${TEMP_MARKER}${randomBytes(6).toString("hex")}`,
  );
}

/**
 * Writes a file so that a concurrent reader sees either the old or the new content, never a mix:
 * the data goes to a temporary file in the same folder, is flushed, and is renamed over the target.
 * Used for linked folders and for the engine's own state.
 */
export async function writeFileAtomic(target: string, data: Uint8Array | string): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  const temp = tempPathFor(target);
  const handle = await open(temp, "wx");
  try {
    await handle.writeFile(data);
    // Flush before the rename, so a crash can't leave a renamed but empty file.
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await withRetries(() => rename(temp, target));
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw error;
  }
}

/** Thrown when a rename would replace an existing file. */
export class TargetExistsError extends Error {
  constructor(readonly key: string) {
    super(`${key} already exists`);
    this.name = "TargetExistsError";
  }
}

/** Creates a `SideFs` over a real folder. */
export function createNodeSideFs(options: NodeSideFsOptions): SideFs {
  const { root } = options;
  const abs = (key: string) => absoluteFromKey(root, key);

  async function* walk(
    folder: string,
    skipFolder: ((key: string) => boolean) | undefined,
  ): AsyncIterable<FileEntry> {
    let dir;
    try {
      dir = await opendir(folder);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for await (const dirent of dir) {
      const full = path.join(folder, dirent.name);
      const key = toKey(path.relative(root, full));
      // lstat, not stat: a symlink or junction is reported as itself and never followed.
      const info = await lstat(full).catch(() => null);
      if (!info) continue; // removed while listing
      if (info.isSymbolicLink()) {
        yield { key, kind: "symlink", size: 0, mtimeMs: info.mtimeMs };
      } else if (info.isDirectory()) {
        if (!skipFolder?.(key)) yield* walk(full, skipFolder);
      } else if (info.isFile()) {
        yield { key, kind: "file", size: info.size, mtimeMs: info.mtimeMs };
      }
    }
  }

  return {
    side: options.side,
    root,
    isWindowsFs: options.isWindowsFs,
    caseInsensitive: options.caseInsensitive,

    list(skipFolder) {
      return walk(root, skipFolder);
    },

    async read(key) {
      return new Uint8Array(await readFile(abs(key)));
    },

    async writeAtomic(key, data) {
      await writeFileAtomic(abs(key), data);
    },

    async rename(from, to) {
      const source = abs(from);
      const target = abs(to);
      if (isCaseOnlyChange(from, to) && options.caseInsensitive) {
        // A case-insensitive filesystem may treat `a.md` -> `A.md` as a no-op, so go through a
        // temporary name to make the new case stick.
        const temp = tempPathFor(target);
        await withRetries(() => rename(source, temp));
        await withRetries(() => rename(temp, target));
        return;
      }
      if (await pathExists(target)) throw new TargetExistsError(to);
      await mkdir(path.dirname(target), { recursive: true });
      await withRetries(() => rename(source, target));
    },

    async trash(key) {
      await withRetries(() => options.trash(abs(key)));
    },

    async exists(key) {
      return pathExists(abs(key));
    },
  };
}

async function pathExists(absolutePath: string): Promise<boolean> {
  try {
    await lstat(absolutePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * A trash for the vault side: moves files into the vault's `.trash` folder, which is Obsidian's
 * own trash, adding a timestamp when a file of that name is already there.
 */
export function vaultTrash(vaultRoot: string, now: () => Date = () => new Date()): TrashFn {
  return async (absolutePath) => {
    const trashFolder = path.join(vaultRoot, ".trash");
    await mkdir(trashFolder, { recursive: true });
    const base = path.basename(absolutePath);
    let target = path.join(trashFolder, base);
    if (await pathExists(target)) {
      const ext = path.extname(base);
      const stamp = now().toISOString().replace(/[:.]/g, "-");
      target = path.join(trashFolder, `${base.slice(0, base.length - ext.length)} ${stamp}${ext}`);
    }
    await rename(absolutePath, target);
  };
}
