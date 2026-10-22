/**
 * Resolving conflicts (REQ-5.0.6): reading the three versions a conflict kept, and writing the
 * user's resolution to both sides as the new base. Must run while holding the engine lock; the
 * extension runs it through its scheduler.
 */
import { applyLineEnding, decodeUtf8, markdownHash, sha256, toLf } from "../scan/index.js";
import type { ConflictRecord } from "../state/index.js";
import type { Project } from "./engine.js";

/** The versions of a conflicted file: its last agreed base, and what each side had. */
export interface ConflictVersions {
  readonly record: ConflictRecord;
  readonly kind: "markdown" | "attachment";
  /** Null when the conflict arose with no agreed base (both sides created the file). */
  readonly base: Uint8Array | null;
  readonly repo: Uint8Array;
  readonly vault: Uint8Array;
}

/** Reads a conflict's three versions from the conflict store, or null if there's no conflict. */
export async function conflictVersions(
  project: Project,
  key: string,
): Promise<ConflictVersions | null> {
  const record = (await project.store.listConflicts()).find((c) => c.key === key);
  if (!record) return null;
  const [base, repo, vault] = await Promise.all([
    record.baseHash ? project.store.getBlob(record.baseHash) : Promise.resolve(null),
    project.store.getBlob(record.repoHash),
    project.store.getBlob(record.vaultHash),
  ]);
  if (!repo || !vault) return null;
  const { index } = await project.store.loadIndex();
  const kind =
    index.entries[key]?.kind ?? (key.toLowerCase().endsWith(".md") ? "markdown" : "attachment");
  return { record, kind, base, repo, vault };
}

/** Thrown when a resolution can't be applied; the message is for the user. */
export class ResolveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResolveError";
  }
}

/**
 * Writes the resolved content to both sides, makes it the new base, and clears the conflict, so
 * later edits sync normally (REQ-5.3). Markdown is given as text and written in each side's line
 * endings; an attachment is given as bytes.
 */
export async function resolveConflict(
  project: Project,
  key: string,
  resolution: string | Uint8Array,
): Promise<void> {
  const { index } = await project.store.loadIndex();
  const entry = index.entries[key];
  if (!entry || entry.state !== "conflict")
    throw new ResolveError(`${key} has no conflict to resolve`);

  let hash: string;
  if (typeof resolution === "string") {
    const lf = toLf(resolution);
    hash = markdownHash(lf);
    await project.store.putBlob(lf);
    const encoder = new TextEncoder();
    await project.repo.writeAtomic(key, encoder.encode(applyLineEnding(lf, entry.repoLineEnding)));
    await project.vault.writeAtomic(
      key,
      encoder.encode(applyLineEnding(lf, entry.vaultLineEnding)),
    );
  } else {
    hash = sha256(resolution);
    await project.repo.writeAtomic(key, resolution);
    await project.vault.writeAtomic(key, resolution);
  }
  await project.store.saveIndex({
    ...index,
    entries: {
      ...index.entries,
      [key]: { ...entry, baseHash: hash, state: "synced", reasons: [] },
    },
  });
  await project.store.removeConflict(key);
}

/** Decodes a Markdown version for display, or null for bytes that aren't text. */
export function versionText(bytes: Uint8Array | null): string | null {
  return bytes === null ? null : decodeUtf8(bytes);
}
