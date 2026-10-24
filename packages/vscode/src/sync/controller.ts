/**
 * The sync controller (design.md `SyncController`): connects file watchers on both folders to the
 * core's scheduler, which holds the lock and runs passes. One controller runs per linked repo.
 */
import { realpathSync, watch } from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import {
  SyncScheduler,
  detectWsl,
  isExcludedFolder,
  isIgnoredChange,
  openProject,
  startNativeWatch,
  startPolling,
  type Project,
  type SchedulerState,
  type SyncOutcome,
} from "@specdevship/project-docs-core";
import { needsPolling } from "./watch-mode.js";

/** Moves a repo-side file to the operating system's trash, through VS Code (REQ-6.0.3). */
export async function vscodeTrash(absolutePath: string): Promise<void> {
  await vscode.workspace.fs.delete(vscode.Uri.file(absolutePath), { useTrash: true });
}

/** The folder's real path, in its long form on Windows, or the path as given if it can't be read. */
function realRoot(folder: string): string {
  try {
    return realpathSync.native(folder);
  } catch {
    return folder;
  }
}

/**
 * True when a changed path, relative to a side's root, is in the link's scope (design decision 21),
 * or is a folder that leads into it. Changes outside it never need a pass.
 */
function inScope(project: Project, relative: string): boolean {
  const key = relative.split(path.sep).join("/");
  return project.scope.includes(key) || project.scope.mayContain(key);
}

/** Runs sync for one linked repo while VS Code has it open. */
export class SyncController implements vscode.Disposable {
  private scheduler: SyncScheduler | null = null;
  private project: Project | null = null;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly stateEmitter = new vscode.EventEmitter<SchedulerState>();
  private readonly passEmitter = new vscode.EventEmitter<SyncOutcome>();
  /** Fires whenever the scheduler's state changes, for the status bar and the problems view. */
  readonly onDidChangeState = this.stateEmitter.event;
  /** Fires after every pass. */
  readonly onDidPass = this.passEmitter.event;

  constructor(readonly repoRoot: string) {}

  get state(): SchedulerState {
    return this.scheduler?.state ?? { state: "starting" };
  }

  get linkedProject(): Project | null {
    return this.project;
  }

  /** Opens the project, starts watching, and runs the first pass. Returns false if it can't. */
  async start(): Promise<boolean> {
    const project = await openProject(this.repoRoot, { repoTrash: vscodeTrash });
    if ("problem" in project) {
      this.stateEmitter.fire({ state: "error", message: project.message });
      return false;
    }
    this.project = project;
    const window = vscode.workspace.name ?? "VS Code";
    this.scheduler = new SyncScheduler({
      project,
      window,
      onState: (state) => this.stateEmitter.fire(state),
      onPass: (outcome) => this.passEmitter.fire(outcome),
    });
    this.watchRepo(project);
    this.watchVault(project);
    await this.scheduler.start();
    return true;
  }

  /**
   * The repo is in the workspace, where VS Code's own watcher is reliable. It watches what the link
   * syncs (design decision 21): the docs folder, recursively, and the Markdown files at the top of
   * the repo root, where the root files are. The rest of the repo isn't watched, so editing source
   * code doesn't start a pass (REQ-20.0.2), and a large repo costs no more watches than its docs.
   * Only changes in the scope start a pass.
   */
  private watchRepo(project: Project): void {
    const root = project.repo.root;
    const docsFolder = project.committed.docsFolder.split("/").filter(Boolean);
    // VS Code reports a change by the file's real path, which can differ in form from the repo
    // root it was given, such as a Windows 8.3 short name (C:\Users\RUNNER~1\...). The relative
    // path is taken from whichever form contains the file, and a change it can't place still
    // starts a pass: an extra pass costs little, and a missed change is a sync failure.
    const roots = [root, realRoot(root)];
    const notify = (uri: vscode.Uri) => {
      const relative = roots
        .map((r) => path.relative(r, uri.fsPath))
        .find((rel) => !rel.startsWith("..") && !path.isAbsolute(rel));
      if (relative === undefined || (!isIgnoredChange(relative) && inScope(project, relative))) {
        this.scheduler?.notify();
      }
    };
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(path.join(root, ...docsFolder)), "**/*"),
    );
    this.disposables.push(
      watcher,
      watcher.onDidCreate(notify),
      watcher.onDidChange(notify),
      watcher.onDidDelete(notify),
    );
    // A repo-root link's watcher above covers the root files. Otherwise they get Node's watcher on
    // the root folder alone: a second VS Code watcher on the docs folder's parent stops the one on
    // the docs folder reporting changes, as VS Code merges overlapping watch requests.
    if (docsFolder.length > 0) {
      try {
        const rootWatcher = watch(root, (_event, name) => {
          if (name === null || project.scope.includes(name.toString())) this.scheduler?.notify();
        });
        rootWatcher.on("error", () => undefined);
        this.disposables.push({ dispose: () => rootWatcher.close() });
      } catch {
        // The periodic rescan still finds changes to the root files.
      }
    }
  }

  /**
   * The vault folder is outside the workspace, where VS Code's watcher doesn't reliably report
   * changes made by other programs, so Node's recursive watcher is used instead; where even that
   * can't be trusted (a Windows drive from WSL, a network share), the folder is polled.
   */
  private watchVault(project: Project): void {
    const notify = () => this.scheduler?.notify();
    const native = needsPolling(project.vault.root, detectWsl())
      ? null
      : startNativeWatch(project.vault.root, notify, undefined, (relative) =>
          inScope(project, relative),
        );
    const skipFolder = (key: string) => isExcludedFolder(key) || !project.scope.mayContain(key);
    const stop = native ?? startPolling(project.vault, { skipFolder, onChange: notify });
    this.disposables.push({ dispose: stop });
  }

  syncNow(options: { allowBulk?: boolean } = {}): Promise<void> {
    return this.scheduler?.syncNow(options) ?? Promise.resolve();
  }

  /** Pauses syncing; resolves once any pass already running has finished. */
  pause(): Promise<void> {
    return this.scheduler?.pause() ?? Promise.resolve();
  }

  resume(): Promise<void> {
    return this.scheduler?.resume() ?? Promise.resolve();
  }

  /** Runs `work` under the engine lock with no pass in progress, then syncs. */
  exclusive<T>(work: (project: Project) => Promise<T>): Promise<T> {
    if (!this.scheduler) return Promise.reject(new Error("Project Docs isn't syncing this repo."));
    return this.scheduler.exclusive(work);
  }

  cancelBulk(): Promise<void> {
    return this.scheduler?.cancelBulk() ?? Promise.resolve();
  }

  /** Stops watching and releases the lock. */
  async stop(): Promise<void> {
    for (const disposable of this.disposables.splice(0)) disposable.dispose();
    await this.scheduler?.dispose();
    this.scheduler = null;
  }

  dispose(): void {
    void this.stop();
    this.stateEmitter.dispose();
    this.passEmitter.dispose();
  }
}
