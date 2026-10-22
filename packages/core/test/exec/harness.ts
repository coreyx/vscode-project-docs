/**
 * A real two-folder harness for executor tests: a repo folder and a vault folder on disk, a state
 * store, and a `pass()` that scans, plans and executes exactly as the engine will.
 */
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { execute, replayJournal, type ExecContext, type PassResult } from "../../src/exec/index.js";
import { EMPTY_PRIVATE_FILES } from "../../src/guards/index.js";
import { createResolver } from "../../src/links/index.js";
import { plan, type LinkSettings, type Plan } from "../../src/plan/index.js";
import { decodeUtf8, scan } from "../../src/scan/index.js";
import { createNodeSideFs, vaultTrash, type SideFs } from "../../src/sidefs/index.js";
import { StateStore, type Index } from "../../src/state/index.js";

export const PROJECT = "pd_3f2c9a1e-7b4d-4c1a-9e2f-5a6b7c8d9e0f";

export interface Harness {
  readonly root: string;
  readonly repoDir: string;
  readonly vaultRoot: string;
  readonly vaultDir: string;
  repo: SideFs;
  vault: SideFs;
  readonly store: StateStore;
  readonly repoTrash: string[];
  settings: LinkSettings;
  mapping: Map<string, string> | null;
  put(side: "repo" | "vault", key: string, content: string | Uint8Array): Promise<void>;
  read(side: "repo" | "vault", key: string): Promise<string | null>;
  remove(side: "repo" | "vault", key: string): Promise<void>;
  /** Plans without executing. */
  planOnly(): Promise<Plan>;
  /** Scans, plans and executes one pass. */
  pass(ctxOverrides?: Partial<ExecContext>): Promise<PassResult>;
  index(): Promise<Index>;
  cleanup(): Promise<void>;
}

export async function harness(): Promise<Harness> {
  const root = await mkdtemp(path.join(tmpdir(), "pd-exec-"));
  const repoDir = path.join(root, "repo", "docs");
  const vaultRoot = path.join(root, "vault");
  const vaultDir = path.join(vaultRoot, "Projects", "repo");
  await mkdir(repoDir, { recursive: true });
  await mkdir(vaultDir, { recursive: true });
  const repoTrash: string[] = [];
  const store = new StateStore(path.join(root, "state"), PROJECT);

  const h: Harness = {
    root,
    repoDir,
    vaultRoot,
    vaultDir,
    repo: createNodeSideFs({
      side: "repo",
      root: repoDir,
      isWindowsFs: false,
      caseInsensitive: false,
      trash: async (p) => {
        repoTrash.push(p);
        await rm(p);
      },
    }),
    vault: createNodeSideFs({
      side: "vault",
      root: vaultDir,
      isWindowsFs: false,
      caseInsensitive: false,
      trash: vaultTrash(vaultRoot),
    }),
    store,
    repoTrash,
    settings: {
      privateSubfolder: "private",
      syncAttachments: false,
      keepLinksAsWritten: false,
      allowLinksOutsideProjectFolder: false,
    },
    mapping: null,
    async put(side, key, content) {
      const full = path.join(side === "repo" ? repoDir : vaultDir, ...key.split("/"));
      await mkdir(path.dirname(full), { recursive: true });
      await writeFile(full, content);
    },
    async read(side, key) {
      try {
        return await readFile(
          path.join(side === "repo" ? repoDir : vaultDir, ...key.split("/")),
          "utf8",
        );
      } catch {
        return null;
      }
    },
    async remove(side, key) {
      await rm(path.join(side === "repo" ? repoDir : vaultDir, ...key.split("/")));
    },
    async planOnly() {
      const { index } = await store.loadIndex();
      const [repoSnap, vaultSnap] = await Promise.all([
        scan(h.repo, { includeAttachments: h.settings.syncAttachments }),
        scan(h.vault, { includeAttachments: h.settings.syncAttachments }),
      ]);
      return plan({
        repo: repoSnap,
        vault: vaultSnap,
        index,
        settings: h.settings,
        repoTraits: { isWindowsFs: h.repo.isWindowsFs, caseInsensitive: h.repo.caseInsensitive },
        vaultTraits: { isWindowsFs: h.vault.isWindowsFs, caseInsensitive: h.vault.caseInsensitive },
        privateFiles: EMPTY_PRIVATE_FILES,
        mapping: h.mapping,
        resolver: createResolver({
          projectFolder: "Projects/repo",
          files: [...vaultSnap.entries.keys()].map((k) => `Projects/repo/${k}`),
        }),
        readText: async (side, key) => {
          const fs = side === "repo" ? h.repo : h.vault;
          return (await fs.exists(key)) ? decodeUtf8(await fs.read(key)) : null;
        },
        readBase: async (hash) => {
          const blob = await store.getBlob(hash);
          return blob ? decodeUtf8(blob) : null;
        },
      });
    },
    async pass(ctxOverrides = {}) {
      const ctx: ExecContext = { repo: h.repo, vault: h.vault, store, ...ctxOverrides };
      const { index } = await store.loadIndex();
      const replayed = await replayJournal(ctx, index);
      const current = replayed?.index ?? index;
      const planned = await h.planOnly();
      return execute(planned, ctx, current);
    },
    async index() {
      return (await store.loadIndex()).index;
    },
    async cleanup() {
      await rm(root, { recursive: true, force: true });
    },
  };
  return h;
}
