/**
 * The engine's state for one project (design.md, Data model): the index of agreed bases, a
 * content-addressed blob store, conflict records, the journal of the pass in progress, and a saved
 * bulk-guarded pass. Every file is written atomically, so a crash leaves either the old or the new
 * version of each, never a torn one.
 */
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import * as path from "node:path";
import { sha256 } from "../scan/index.js";
import { writeFileAtomic } from "../sidefs/index.js";
import type { LineEnding } from "../scan/index.js";

/** Format version of every state file; bumped only when a file's shape changes incompatibly. */
export const STATE_FORMAT = 1;

/** What the engine knows about one key between passes. */
export interface IndexEntry {
  readonly key: string;
  readonly kind: "markdown" | "attachment";
  /** Hash of the last content both sides agreed on; its bytes are in the blob store. */
  readonly baseHash: string;
  readonly repoLineEnding: LineEnding;
  readonly vaultLineEnding: LineEnding;
  /**
   * `synced` keys have an agreed base. `conflict` and `heldBack` keys are frozen until the user
   * acts (design decision 5). `skipped` keys can't sync for now. `vaultOnly` keys are private vault
   * files that never sync; for them `baseHash` is the vault content last seen, so the planner only
   * re-reads them when they change, and the guards can tell a link to them is private. `detached`
   * keys are repo copies of notes that became private: left in place, never synced, and reported
   * until the user removes them (design decision 9).
   */
  readonly state: "synced" | "conflict" | "heldBack" | "skipped" | "vaultOnly" | "detached";
  /** Why the key isn't synced; placeholders only, never real values. */
  readonly reasons: readonly string[];
}

/** The index: every key with an agreed base. */
export interface Index {
  readonly format: number;
  readonly projectId: string;
  readonly entries: Record<string, IndexEntry>;
}

/** A conflict waiting for the user, with the hashes of all three versions. */
export interface ConflictRecord {
  readonly key: string;
  readonly baseHash: string | null;
  readonly repoHash: string;
  readonly vaultHash: string;
  readonly createdAt: string;
}

/** Result of loading the index: whether it had to be rebuilt from nothing. */
export interface LoadedIndex {
  readonly index: Index;
  /** True when an index existed but couldn't be read; the next pass is then a first sync. */
  readonly recovered: boolean;
}

function isIndex(value: unknown, projectId: string): value is Index {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<Index>;
  return (
    candidate.format === STATE_FORMAT &&
    candidate.projectId === projectId &&
    typeof candidate.entries === "object" &&
    candidate.entries !== null
  );
}

/** Reads and writes one project's state folder. */
export class StateStore {
  constructor(
    readonly dir: string,
    readonly projectId: string,
  ) {}

  private file(...parts: string[]): string {
    return path.join(this.dir, ...parts);
  }

  private async readJson(file: string): Promise<unknown | undefined> {
    try {
      return JSON.parse(await readFile(file, "utf8")) as unknown;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      // Unparseable content is treated like a missing file by callers that can recover from it.
      return null;
    }
  }

  private async writeJson(file: string, value: unknown): Promise<void> {
    await writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
  }

  /** An empty index for this project. */
  emptyIndex(): Index {
    return { format: STATE_FORMAT, projectId: this.projectId, entries: {} };
  }

  /**
   * Loads the index. A missing index is a new project; a corrupt or foreign one is replaced by an
   * empty index, which makes the next pass a first sync that can never delete anything
   * (design decision 10, REQ-19.0.4).
   */
  async loadIndex(): Promise<LoadedIndex> {
    const value = await this.readJson(this.file("index.json"));
    if (value === undefined) return { index: this.emptyIndex(), recovered: false };
    if (!isIndex(value, this.projectId)) return { index: this.emptyIndex(), recovered: true };
    return { index: value, recovered: false };
  }

  async saveIndex(index: Index): Promise<void> {
    await this.writeJson(this.file("index.json"), index);
  }

  private blobPath(hash: string): string {
    if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error(`Invalid blob hash: ${hash}`);
    return this.file("blobs", hash.slice(0, 2), hash);
  }

  /** Stores content and returns its SHA-256, which is also its name. Storing twice is harmless. */
  async putBlob(content: Uint8Array | string): Promise<string> {
    const hash = sha256(content);
    const target = this.blobPath(hash);
    try {
      await readFile(target);
    } catch {
      await writeFileAtomic(target, content);
    }
    return hash;
  }

  /** Returns a stored blob's bytes, or null if it isn't there. */
  async getBlob(hash: string): Promise<Uint8Array | null> {
    try {
      return new Uint8Array(await readFile(this.blobPath(hash)));
    } catch {
      return null;
    }
  }

  /** Deletes every blob not in `referenced`. Called after a successful pass. */
  async collectGarbage(referenced: ReadonlySet<string>): Promise<number> {
    let removed = 0;
    const root = this.file("blobs");
    let prefixes: string[];
    try {
      prefixes = await readdir(root);
    } catch {
      return 0;
    }
    for (const prefix of prefixes) {
      for (const name of await readdir(path.join(root, prefix)).catch(() => [] as string[])) {
        if (!referenced.has(name)) {
          await rm(path.join(root, prefix, name), { force: true });
          removed++;
        }
      }
    }
    return removed;
  }

  private conflictPath(key: string): string {
    // Keys can contain characters folder names can't, so conflicts are named by the key's hash.
    return this.file("conflicts", `${sha256(key)}.json`);
  }

  async saveConflict(conflict: ConflictRecord): Promise<void> {
    await this.writeJson(this.conflictPath(conflict.key), conflict);
  }

  async removeConflict(key: string): Promise<void> {
    await rm(this.conflictPath(key), { force: true });
  }

  async listConflicts(): Promise<ConflictRecord[]> {
    const folder = this.file("conflicts");
    const names = await readdir(folder).catch(() => [] as string[]);
    const records: ConflictRecord[] = [];
    for (const name of names) {
      const value = await this.readJson(path.join(folder, name));
      if (value && typeof value === "object") records.push(value as ConflictRecord);
    }
    return records.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }

  /** Returns the saved journal, or null if no pass is unfinished. */
  async loadJournal<T>(): Promise<T | null> {
    const value = await this.readJson(this.file("journal.json"));
    return (value ?? null) as T | null;
  }

  async saveJournal(journal: unknown): Promise<void> {
    await this.writeJson(this.file("journal.json"), journal);
  }

  async clearJournal(): Promise<void> {
    await rm(this.file("journal.json"), { force: true });
  }

  /** Returns the pass held back by the bulk guard, or null (REQ-7.0.2). */
  async loadPendingBulk<T>(): Promise<T | null> {
    const value = await this.readJson(this.file("pending-bulk.json"));
    return (value ?? null) as T | null;
  }

  async savePendingBulk(plan: unknown): Promise<void> {
    await this.writeJson(this.file("pending-bulk.json"), plan);
  }

  async clearPendingBulk(): Promise<void> {
    await rm(this.file("pending-bulk.json"), { force: true });
  }

  /** Consecutive failed writes per key, so repeated failures can be surfaced (TASK-14). */
  async loadFailures(): Promise<Record<string, number>> {
    const value = await this.readJson(this.file("failures.json"));
    return value && typeof value === "object" ? (value as Record<string, number>) : {};
  }

  async saveFailures(failures: Record<string, number>): Promise<void> {
    if (Object.keys(failures).length === 0) {
      await rm(this.file("failures.json"), { force: true });
      return;
    }
    await this.writeJson(this.file("failures.json"), failures);
  }

  /** Creates the state folder if needed. */
  async ensure(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
  }
}
