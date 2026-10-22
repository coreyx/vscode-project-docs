/**
 * The executor (design decision 11): carries out a plan through a journal, so a pass interrupted by
 * a crash, a power cut or VS Code closing is finished safely on the next start (REQ-19.0.3).
 *
 * Every action is idempotent and re-checks, just before it writes, that both sides are still as
 * the planner saw them. An action whose files changed since planning is skipped as stale rather
 * than overwriting something the planner never saw; the next pass plans it afresh. That check is
 * what makes replaying a journal safe at any point.
 */
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import type { Action, Notice, Plan } from "../plan/index.js";
import {
  applyLineEnding,
  decodeUtf8,
  markdownHash,
  sha256,
  toLf,
  type LineEnding,
} from "../scan/index.js";
import { writeFileAtomic, type Side, type SideFs } from "../sidefs/index.js";
import type { Index, IndexEntry, StateStore } from "../state/index.js";
import type { Logger } from "../log/index.js";

/** Bumped only when the journal's shape changes incompatibly. */
export const JOURNAL_FORMAT = 1;

/** A pass in progress, saved before its first action. */
export interface Journal {
  readonly format: number;
  readonly startedAt: string;
  readonly actions: readonly Action[];
  readonly notices: readonly Notice[];
  /** Positions in `actions` already carried out. */
  readonly done: readonly number[];
}

/** What the executor needs. */
export interface ExecContext {
  readonly repo: SideFs;
  readonly vault: SideFs;
  readonly store: StateStore;
  readonly logger?: Logger | undefined;
  readonly now?: () => Date;
}

/** A write that failed, with how many passes in a row it has failed. */
export interface FailedAction {
  readonly key: string;
  readonly message: string;
  readonly consecutive: number;
}

/** The outcome of a pass. */
export interface PassResult {
  readonly applied: number;
  /** Actions skipped because a file changed after planning; the next pass plans them again. */
  readonly stale: number;
  readonly failed: readonly FailedAction[];
  readonly index: Index;
}

/** After this many consecutive failed passes, a failing write is reported to the user. */
export const REPORT_FAILURES_AFTER = 3;

/** Where the status file the plugin reads lives (design decision 7). */
export function statusFilePath(vaultRoot: string): string {
  return path.join(vaultRoot, ".project-docs", "status.json");
}

class Stale extends Error {}

async function currentHash(
  fs: SideFs,
  key: string,
  kind: "markdown" | "attachment",
): Promise<string | null> {
  if (!(await fs.exists(key))) return null;
  const bytes = await fs.read(key);
  if (kind === "attachment") return sha256(bytes);
  const text = decodeUtf8(bytes);
  return text === null ? sha256(bytes) : markdownHash(text);
}

const encoder = new TextEncoder();

function markdownBytes(lfText: string, ending: LineEnding): Uint8Array {
  return encoder.encode(applyLineEnding(lfText, ending));
}

/** Runs a plan, journaling as it goes. */
export async function execute(plan: Plan, ctx: ExecContext, index: Index): Promise<PassResult> {
  const now = ctx.now ?? (() => new Date());
  const journal: Journal = {
    format: JOURNAL_FORMAT,
    startedAt: now().toISOString(),
    actions: plan.actions,
    notices: plan.notices,
    done: [],
  };
  await ctx.store.ensure();
  await ctx.store.saveJournal(journal);
  return runJournal(journal, ctx, index);
}

/**
 * Finishes an interrupted pass, if there is one, before anything is planned (REQ-19.0.3).
 * Returns null when there was nothing to replay.
 */
export async function replayJournal(ctx: ExecContext, index: Index): Promise<PassResult | null> {
  const journal = await ctx.store.loadJournal<Journal>();
  if (!journal) return null;
  if (journal.format !== JOURNAL_FORMAT || !Array.isArray(journal.actions)) {
    // A journal this version can't read: drop it. Replanning from the files is always safe.
    await ctx.store.clearJournal();
    return null;
  }
  await ctx.logger?.info(`replaying an interrupted pass from ${journal.startedAt}`);
  return runJournal(journal, ctx, index);
}

async function runJournal(
  journal: Journal,
  ctx: ExecContext,
  startIndex: Index,
): Promise<PassResult> {
  const entries: Record<string, IndexEntry> = { ...startIndex.entries };
  let index: Index = { ...startIndex, entries };
  const done = new Set(journal.done);
  const failures = await ctx.store.loadFailures();
  const failed: FailedAction[] = [];
  let applied = 0;
  let stale = 0;
  // A failed or stale action leaves its key untouched for the rest of the pass, so later actions
  // for the same key (a copy after a rename) don't run against an unexpected state.
  const blocked = new Set<string>();

  for (const [position, action] of journal.actions.entries()) {
    if (done.has(position)) continue;
    const keys = action.type === "rename" ? [action.from, action.to] : [action.key];
    if (keys.some((k) => blocked.has(k))) continue;
    try {
      await apply(action, ctx);
      const { key, entry } = action.update;
      if (action.type === "rename") delete entries[action.removeKey];
      if (entry) entries[key] = entry;
      else delete entries[key];
      index = { ...index, entries };
      await ctx.store.saveIndex(index);
      applied++;
      delete failures[action.type === "rename" ? action.to : action.key];
    } catch (error) {
      keys.forEach((k) => blocked.add(k));
      if (error instanceof Stale) {
        stale++;
        await ctx.logger?.info(`skipped ${keys.join(" -> ")}: ${error.message}`);
      } else {
        const key = keys[keys.length - 1] ?? "";
        const consecutive = (failures[key] ?? 0) + 1;
        failures[key] = consecutive;
        const message = error instanceof Error ? error.message : String(error);
        failed.push({ key, message, consecutive });
        await ctx.logger?.warn(
          `failed ${action.type} ${key} (${consecutive} in a row): ${message}`,
        );
      }
    }
    done.add(position);
    await ctx.store.saveJournal({ ...journal, done: [...done] });
  }

  await ctx.store.saveFailures(failures);
  await ctx.store.clearJournal();
  await writeStatus(ctx, journal.notices, failed, now(ctx));
  await collectGarbage(ctx.store, index);
  return { applied, stale, failed, index };
}

function now(ctx: ExecContext): Date {
  return (ctx.now ?? (() => new Date()))();
}

function fsFor(ctx: ExecContext, side: Side): SideFs {
  return side === "repo" ? ctx.repo : ctx.vault;
}

/** Carries out one action, or throws Stale if the files changed since planning. */
async function apply(action: Action, ctx: ExecContext): Promise<void> {
  switch (action.type) {
    case "copy": {
      const source = fsFor(ctx, action.from);
      const target = fsFor(ctx, action.from === "repo" ? "vault" : "repo");
      const targetHash = await currentHash(target, action.key, action.kind);
      if (targetHash === action.hash) {
        if (action.kind === "markdown") await storeBase(ctx, source, action.key);
        return; // already done
      }
      if (targetHash !== action.expectTargetHash)
        throw new Stale("the target changed after planning");
      const bytes = (await source.exists(action.key)) ? await source.read(action.key) : null;
      if (bytes === null) throw new Stale("the source disappeared after planning");
      if (action.kind === "attachment") {
        if (sha256(bytes) !== action.hash) throw new Stale("the source changed after planning");
        await target.writeAtomic(action.key, bytes);
        return;
      }
      const text = decodeUtf8(bytes);
      if (text === null || markdownHash(text) !== action.hash) {
        throw new Stale("the source changed after planning");
      }
      await ctx.store.putBlob(toLf(text));
      await target.writeAtomic(action.key, markdownBytes(toLf(text), action.targetLineEnding));
      return;
    }
    case "writeBoth": {
      const repoHash = await currentHash(ctx.repo, action.key, "markdown");
      const vaultHash = await currentHash(ctx.vault, action.key, "markdown");
      const repoReady = repoHash === action.hash || repoHash === action.expectRepoHash;
      const vaultReady = vaultHash === action.hash || vaultHash === action.expectVaultHash;
      if (!repoReady || !vaultReady) throw new Stale("a side changed after planning");
      await ctx.store.putBlob(action.text);
      if (repoHash !== action.hash) {
        await ctx.repo.writeAtomic(action.key, markdownBytes(action.text, action.repoLineEnding));
      }
      if (vaultHash !== action.hash) {
        await ctx.vault.writeAtomic(action.key, markdownBytes(action.text, action.vaultLineEnding));
      }
      return;
    }
    case "rename": {
      const fs = fsFor(ctx, action.side);
      const [fromExists, toExists] = await Promise.all([
        fs.exists(action.from),
        fs.exists(action.to),
      ]);
      if (!fromExists && toExists) return; // already renamed
      if (!fromExists) throw new Stale("the file to rename disappeared after planning");
      if (toExists && action.from.toLowerCase() !== action.to.toLowerCase()) {
        throw new Stale("the new name is taken");
      }
      await fs.rename(action.from, action.to);
      return;
    }
    case "trash": {
      const fs = fsFor(ctx, action.side);
      const hash = await currentHash(
        fs,
        action.key,
        action.update.entry?.kind ?? kindOf(action.key),
      );
      if (hash === null) return; // already gone
      // Only ever trash exactly what was planned: a file edited since must not be thrown away.
      if (hash !== action.hash) throw new Stale("the file changed after planning");
      await fs.trash(action.key);
      return;
    }
    case "conflict": {
      const [repoHash, vaultHash] = await Promise.all([
        currentHash(ctx.repo, action.key, action.kind),
        currentHash(ctx.vault, action.key, action.kind),
      ]);
      if (repoHash !== action.repoHash) throw new Stale("the repo copy changed after planning");
      if (vaultHash === action.repoHash) return; // already done
      if (vaultHash !== action.vaultHash) throw new Stale("the vault copy changed after planning");
      const [repoBytes, vaultBytes] = await Promise.all([
        ctx.repo.read(action.key),
        ctx.vault.read(action.key),
      ]);
      const storable = (bytes: Uint8Array) => {
        if (action.kind === "attachment") return bytes;
        return toLf(decodeUtf8(bytes) ?? "");
      };
      // Keep every version before anything is overwritten (REQ-5.0.4).
      await ctx.store.putBlob(storable(vaultBytes));
      await ctx.store.putBlob(storable(repoBytes));
      await ctx.store.saveConflict({
        key: action.key,
        baseHash: action.baseHash,
        repoHash: action.repoHash,
        vaultHash: action.vaultHash,
        createdAt: new Date().toISOString(),
      });
      const replacement =
        action.kind === "attachment"
          ? repoBytes
          : markdownBytes(toLf(decodeUtf8(repoBytes) ?? ""), action.vaultLineEnding);
      await ctx.vault.writeAtomic(action.key, replacement);
      return;
    }
    case "adopt": {
      if (action.update.entry?.kind === "markdown") await storeBase(ctx, ctx.repo, action.key);
      return;
    }
    case "record":
      return;
  }
}

function kindOf(key: string): "markdown" | "attachment" {
  return key.toLowerCase().endsWith(".md") ? "markdown" : "attachment";
}

/** Saves a file's current LF text as a base blob, so later merges have their common ancestor. */
async function storeBase(ctx: ExecContext, fs: SideFs, key: string): Promise<void> {
  const text = decodeUtf8(await fs.read(key));
  if (text !== null) await ctx.store.putBlob(toLf(text));
}

/** Writes the status the plugin and the status bar show (REQ-17). Contains no real values. */
async function writeStatus(
  ctx: ExecContext,
  notices: readonly Notice[],
  failed: readonly FailedAction[],
  at: Date,
): Promise<void> {
  const items = [
    ...notices.map((n) => ({
      kind: n.code,
      path: n.key,
      message: n.message,
      reasons: n.reasons ?? [],
      ...(n.fix ? { fix: n.fix } : {}),
    })),
    ...failed
      .filter((f) => f.consecutive >= REPORT_FAILURES_AFTER)
      .map((f) => ({
        kind: "write-failing",
        path: f.key,
        message: `${f.key} has failed to sync ${f.consecutive} times in a row: ${f.message}`,
        reasons: [],
      })),
  ];
  const file = statusFilePath(ctx.vault.root);
  const state = items.length > 0 ? "attention" : "idle";
  // Rewrite only when something changed: an unchanged status written after every pass would keep
  // file watchers (the plugin's, and any on the vault) busy for nothing.
  try {
    const previous = JSON.parse(await readFile(file, "utf8")) as {
      state?: unknown;
      items?: unknown;
    };
    if (previous.state === state && JSON.stringify(previous.items) === JSON.stringify(items))
      return;
  } catch {
    // No status yet, or an unreadable one: write it.
  }
  const status = { format: 1, updatedAt: at.toISOString(), state, items };
  await writeFileAtomic(file, `${JSON.stringify(status, null, 2)}\n`);
}

/** Deletes blobs nothing refers to any more: not a base, and not part of a conflict. */
async function collectGarbage(store: StateStore, index: Index): Promise<void> {
  const referenced = new Set<string>();
  for (const entry of Object.values(index.entries))
    if (entry.baseHash) referenced.add(entry.baseHash);
  for (const conflict of await store.listConflicts()) {
    for (const hash of [conflict.baseHash, conflict.repoHash, conflict.vaultHash]) {
      if (hash) referenced.add(hash);
    }
  }
  await store.collectGarbage(referenced);
}
