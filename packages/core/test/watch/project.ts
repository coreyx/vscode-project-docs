/** A real linked project in temporary folders, opened through the engine, for scheduler tests. */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { openProject, type Project } from "../../src/engine/index.js";
import {
  DEFAULT_SETTINGS,
  committedRecord,
  linkNotePathFor,
  localRecord,
  newProjectId,
  writeLink,
} from "../../src/records/index.js";

export interface LinkedProject {
  readonly root: string;
  readonly docs: string;
  readonly vaultFolder: string;
  readonly stateRoot: string;
  open(): Promise<Project>;
  cleanup(): Promise<void>;
}

export async function linkedProject(base?: string): Promise<LinkedProject> {
  const root = await mkdtemp(path.join(base ?? tmpdir(), "pd-sched-"));
  const repo = path.join(root, "repo");
  const vaultRoot = path.join(root, "vault");
  const vaultFolder = path.join(vaultRoot, "Projects", "repo");
  const stateRoot = path.join(root, "state");
  await mkdir(path.join(repo, "docs"), { recursive: true });
  await mkdir(vaultFolder, { recursive: true });
  const projectId = newProjectId();
  await writeLink(
    repo,
    committedRecord({
      projectId,
      docsFolder: "docs",
      vaultFolder: "Projects/repo",
      settings: DEFAULT_SETTINGS,
    }),
    localRecord({
      projectId,
      vaultRoot,
      vaultFolderPath: vaultFolder,
      linkNotePath: linkNotePathFor(vaultFolder, DEFAULT_SETTINGS.folderNotePattern),
    }),
  );
  return {
    root,
    docs: path.join(repo, "docs"),
    vaultFolder,
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
