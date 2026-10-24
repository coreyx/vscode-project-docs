/** A real linked project in temporary folders, opened through the engine, for scheduler tests. */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { openProject, type Project } from "../../src/engine/index.js";
import {
  DEFAULT_SETTINGS,
  type LinkSettingsRecord,
  committedRecord,
  linkNotePathFor,
  localRecord,
  newProjectId,
  writeLink,
} from "../../src/records/index.js";

export interface LinkedProject {
  readonly root: string;
  /** The repo's root folder. */
  readonly repo: string;
  readonly docs: string;
  readonly vaultFolder: string;
  /** The vault's copy of the docs folder: the vault folder mirrors the repo (design decision 21). */
  readonly vaultDocs: string;
  readonly stateRoot: string;
  open(): Promise<Project>;
  cleanup(): Promise<void>;
}

/** How to link: the docs folder (`""` for the repo root) and settings to change from the defaults. */
export interface LinkOptions {
  readonly docsFolder?: string;
  readonly settings?: Partial<LinkSettingsRecord>;
}

export async function linkedProject(
  base?: string,
  options: LinkOptions = {},
): Promise<LinkedProject> {
  const docsFolder = options.docsFolder ?? "docs";
  const settings = { ...DEFAULT_SETTINGS, ...options.settings };
  const root = await mkdtemp(path.join(base ?? tmpdir(), "pd-sched-"));
  const repo = path.join(root, "repo");
  const vaultRoot = path.join(root, "vault");
  const vaultFolder = path.join(vaultRoot, "Projects", "repo");
  const stateRoot = path.join(root, "state");
  const docs = path.join(repo, ...docsFolder.split("/").filter(Boolean));
  await mkdir(docs, { recursive: true });
  // The vault folder mirrors the repo, so its copy of the docs folder is there from the start.
  await mkdir(path.join(vaultFolder, ...docsFolder.split("/").filter(Boolean)), {
    recursive: true,
  });
  const projectId = newProjectId();
  await writeLink(
    repo,
    committedRecord({
      projectId,
      docsFolder,
      vaultFolder: "Projects/repo",
      settings,
    }),
    localRecord({
      projectId,
      vaultRoot,
      vaultFolderPath: vaultFolder,
      linkNotePath: linkNotePathFor(vaultFolder, settings.folderNotePattern),
    }),
  );
  return {
    root,
    repo,
    docs,
    vaultFolder,
    vaultDocs: path.join(vaultFolder, ...docsFolder.split("/").filter(Boolean)),
    stateRoot,
    async open() {
      const project = await openProject(repo, { repoTrash: async (p) => rm(p), stateRoot });
      if ("problem" in project) throw new Error(project.message);
      return project;
    },
    async cleanup() {
      await rm(root, { recursive: true, force: true });
    },
  };
}
