/**
 * Property-based tests of the whole engine (TASK-15, REQ-5.4, REQ-19.2, REQ-19.3).
 *
 * fast-check generates histories of edits, creates, deletes, renames, privacy changes, crashes
 * mid-pass, failing writes and lost engine state on both sides of two real folders, running sync
 * passes in between. After every pass two invariants must hold:
 *
 *  - No loss: every file version a pass replaced or removed was the agreed base (so the other
 *    side's newer edit legitimately superseded it), an input to a merge, saved in the conflict
 *    store, moved to a trash, or is still on disk somewhere.
 *  - No leak: nothing private (a private note's later content, a real value from PRIVATE.md, a
 *    link or path into the private folder) is ever in the repo folder.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fc from "fast-check";
import { readdir, readFile, rm } from "node:fs/promises";
import * as path from "node:path";
import { execute, replayJournal, type ExecContext } from "../../src/exec/index.js";
import type { Plan } from "../../src/plan/index.js";
import { decodeUtf8, markdownHash, sha256 } from "../../src/scan/index.js";
import type { SideFs } from "../../src/sidefs/index.js";
import { harness, type Harness } from "../exec/harness.js";

const KEYS = ["a.md", "b.md", "c.md", "sub/d.md"] as const;
const SIDES = ["repo", "vault"] as const;
const REAL_VALUE = "REALHOST1";

type Op =
  | { t: "edit"; side: "repo" | "vault"; key: string; line: number; word: string }
  | { t: "delete"; side: "repo" | "vault"; key: string }
  | { t: "rename"; side: "repo" | "vault"; from: string; to: string }
  | { t: "makePrivate"; key: string }
  | { t: "moveToPrivate"; key: string }
  | { t: "addRealValue"; key: string }
  | { t: "linkPrivate"; key: string }
  | { t: "pass" }
  | { t: "crashPass"; at: number }
  | { t: "failingPass" }
  | { t: "dropState" };

const key = fc.constantFrom(...KEYS);
const side = fc.constantFrom(...SIDES);
const op: fc.Arbitrary<Op> = fc.oneof(
  {
    weight: 6,
    arbitrary: fc.record({
      t: fc.constant("edit" as const),
      side,
      key,
      line: fc.nat(5),
      word: fc.constantFrom("alpha", "beta", "gamma", "delta"),
    }),
  },
  { weight: 2, arbitrary: fc.record({ t: fc.constant("delete" as const), side, key }) },
  {
    weight: 2,
    arbitrary: fc.record({ t: fc.constant("rename" as const), side, from: key, to: key }),
  },
  { weight: 1, arbitrary: fc.record({ t: fc.constant("makePrivate" as const), key }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant("moveToPrivate" as const), key }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant("addRealValue" as const), key }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant("linkPrivate" as const), key }) },
  { weight: 4, arbitrary: fc.constant({ t: "pass" as const }) },
  {
    weight: 1,
    arbitrary: fc.record({
      t: fc.constant("crashPass" as const),
      at: fc.integer({ min: 2, max: 6 }),
    }),
  },
  { weight: 1, arbitrary: fc.constant({ t: "failingPass" as const }) },
  { weight: 1, arbitrary: fc.constant({ t: "dropState" as const }) },
);

let h: Harness;
let originalRepo: SideFs;
let originalVault: SideFs;
/** Counter for unique private content, so a leak is unmistakable. */
let privateCounter = 0;

beforeEach(async () => {
  h = await harness();
  h.mapping = new Map([["myhost", REAL_VALUE]]);
  originalRepo = h.repo;
  originalVault = h.vault;
  await h.put("vault", "private/p.md", "the private target\n");
});

afterEach(async () => {
  await h.cleanup();
});

/** Records every file content a pass replaces or trashes, through wrapped filesystems. */
interface Replaced {
  readonly side: "repo" | "vault";
  readonly key: string;
  readonly hash: string;
}

function hashFile(key: string, bytes: Uint8Array): string {
  if (!key.toLowerCase().endsWith(".md")) return sha256(bytes);
  const text = decodeUtf8(bytes);
  return text === null ? sha256(bytes) : markdownHash(text);
}

function recording(fs: SideFs, log: Replaced[], failWrites: boolean): SideFs {
  const before = async (k: string) => {
    if (await fs.exists(k))
      log.push({ side: fs.side, key: k, hash: hashFile(k, await fs.read(k)) });
  };
  return {
    ...fs,
    list: (skip) => fs.list(skip),
    read: (k) => fs.read(k),
    exists: (k) => fs.exists(k),
    rename: (from, to) => fs.rename(from, to),
    async writeAtomic(k, data) {
      if (failWrites && k.length % 2 === 0)
        throw Object.assign(new Error("disk says no"), { code: "EIO" });
      await before(k);
      await fs.writeAtomic(k, data);
    },
    async trash(k) {
      // A trashed file is preserved by definition (it can be restored), so it isn't recorded.
      await fs.trash(k);
    },
  };
}

async function filesOn(dir: string, prefix = ""): Promise<Map<string, Uint8Array>> {
  const result = new Map<string, Uint8Array>();
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return result;
  }
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (entry.name === ".project-docs") continue;
      for (const [k, v] of await filesOn(path.join(dir, entry.name), rel)) result.set(k, v);
    } else {
      result.set(rel, new Uint8Array(await readFile(path.join(dir, entry.name))));
    }
  }
  return result;
}

async function onDiskHashes(): Promise<Set<string>> {
  const hashes = new Set<string>();
  for (const dir of [h.repoDir, h.vaultRoot]) {
    for (const [k, bytes] of await filesOn(dir)) hashes.add(hashFile(k, bytes));
  }
  return hashes;
}

/** Runs one pass the way the engine does, checking the no-loss invariant around it. */
async function checkedPass(
  options: { crashAt?: number; failWrites?: boolean } = {},
): Promise<void> {
  const replaced: Replaced[] = [];
  h.repo = recording(originalRepo, replaced, options.failWrites ?? false);
  h.vault = recording(originalVault, replaced, options.failWrites ?? false);
  // Any agreed base, under any key: a rename moves a base to a new key within the same pass.
  const basesBefore = new Set(Object.values((await h.index()).entries).map((e) => e.baseHash));
  const executed: Plan[] = [];
  let store = h.store;
  if (options.crashAt !== undefined) {
    let saves = 0;
    store = Object.create(h.store) as typeof h.store;
    store.saveJournal = async (journal) => {
      saves++;
      if (saves === options.crashAt) throw new Error("simulated crash");
      return h.store.saveJournal(journal);
    };
  }
  const ctx: ExecContext = { repo: h.repo, vault: h.vault, store };
  try {
    const { index } = await h.store.loadIndex();
    const replayed = await replayJournal({ ...ctx, store: h.store }, index);
    const planned = await h.planOnly();
    executed.push(planned);
    await execute(planned, ctx, replayed?.index ?? index);
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "simulated crash") throw error;
  } finally {
    h.repo = originalRepo;
    h.vault = originalVault;
  }

  // No loss.
  const disk = await onDiskHashes();
  const mergeInputs = new Set<string>();
  for (const p of executed) {
    for (const a of p.actions) {
      if (a.type === "writeBoth") {
        if (a.expectRepoHash) mergeInputs.add(a.expectRepoHash);
        if (a.expectVaultHash) mergeInputs.add(a.expectVaultHash);
      }
    }
  }
  for (const r of replaced) {
    const kept =
      disk.has(r.hash) ||
      basesBefore.has(r.hash) ||
      mergeInputs.has(r.hash) ||
      (await h.store.getBlob(r.hash)) !== null;
    expect(kept, `${r.side}/${r.key} lost a version (${r.hash.slice(0, 8)})`).toBe(true);
  }

  // No leak.
  for (const [k, bytes] of await filesOn(h.repoDir)) {
    const text = new TextDecoder().decode(bytes);
    expect(k.startsWith("private/"), `${k} is in the repo`).toBe(false);
    expect(text, `private content in ${k}`).not.toMatch(/PRIV\d+/);
    expect(text.toLowerCase(), `real value in ${k}`).not.toContain(REAL_VALUE.toLowerCase());
    expect(text, `private link in ${k}`).not.toContain("private/");
  }
}

async function apply(o: Op): Promise<void> {
  switch (o.t) {
    case "edit": {
      // Edits change the body only: rewriting frontmatter would remove a private marker, which is
      // a deliberate user action, not something random edits should stumble into.
      const text = (await h.read(o.side, o.key)) ?? "";
      const NL = String.fromCharCode(10);
      const frontmatter = new RegExp(`^---${NL}[^]*?${NL}---${NL}`).exec(text)?.[0] ?? "";
      const lines = text
        .slice(frontmatter.length)
        .split(NL)
        .filter((l) => l !== "");
      while (lines.length <= o.line) lines.push(`line ${lines.length}`);
      lines[o.line] = `${o.word} ${o.side} ${o.line}`;
      await h.put(o.side, o.key, `${frontmatter}${lines.join(NL + NL)}${NL}`);
      return;
    }
    case "delete":
      if ((await h.read(o.side, o.key)) !== null) await h.remove(o.side, o.key);
      return;
    case "rename": {
      const text = await h.read(o.side, o.from);
      if (text === null || o.from === o.to || (await h.read(o.side, o.to)) !== null) return;
      await h.remove(o.side, o.from);
      await h.put(o.side, o.to, text);
      return;
    }
    case "makePrivate": {
      const text = (await h.read("vault", o.key)) ?? "";
      await h.put(
        "vault",
        o.key,
        `---\nproject-docs: private\n---\nPRIV${++privateCounter}\n${text.replace(/^---[\s\S]*?---\n/, "")}`,
      );
      return;
    }
    case "moveToPrivate": {
      const text = await h.read("vault", o.key);
      if (text === null) return;
      await h.remove("vault", o.key);
      await h.put("vault", `private/${o.key}`, `${text}PRIV${++privateCounter}\n`);
      return;
    }
    case "addRealValue": {
      const text = (await h.read("vault", o.key)) ?? "";
      await h.put("vault", o.key, `${text}ssh ${REAL_VALUE.toLowerCase()}\n`);
      return;
    }
    case "linkPrivate": {
      const text = (await h.read("vault", o.key)) ?? "";
      await h.put("vault", o.key, `${text}see [[private/p]]\n`);
      return;
    }
    case "pass":
      return checkedPass();
    case "crashPass":
      return checkedPass({ crashAt: o.at });
    case "failingPass":
      return checkedPass({ failWrites: true });
    case "dropState": {
      const before = await filesOn(h.root);
      await rm(h.store.dir, { recursive: true, force: true });
      await checkedPass();
      // Lost state must never cause a delete (REQ-19.3).
      const after = await filesOn(h.root);
      for (const k of before.keys()) {
        if (k.startsWith("state/") || k.includes(".project-docs/")) continue;
        expect(after.has(k), `${k} was deleted after the state was lost`).toBe(true);
      }
      return;
    }
  }
}

describe("sync engine properties", () => {
  it("never loses a version and never leaks private content, over random histories", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(op, { minLength: 1, maxLength: 18 }), async (ops) => {
        // Each run starts from fresh folders.
        await h.cleanup();
        h = await harness();
        h.mapping = new Map([["myhost", REAL_VALUE]]);
        originalRepo = h.repo;
        originalVault = h.vault;
        await h.put("vault", "private/p.md", "the private target\n");
        for (const o of ops) await apply(o);
        // Settle: two more passes, then everything must be stable.
        await checkedPass();
        await checkedPass();
        const finalPlan = await h.planOnly();
        const writes = finalPlan.actions.filter((a) => a.type !== "record");
        expect(writes, "a settled pair of folders still has work to do").toEqual([]);
      }),
      { numRuns: Number(process.env["PROJECT_DOCS_PROPERTY_RUNS"] ?? 40) },
    );
  }, 600_000);
});
