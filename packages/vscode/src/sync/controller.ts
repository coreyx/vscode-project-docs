/**
 * The sync controller (design.md `SyncController`): connects file watchers on both folders to the
 * core's scheduler, which holds the lock and runs passes. One controller runs per linked repo.
 */
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

  /** The docs folder is in the workspace, where VS Code's own watcher is reliable. */
  private watchRepo(project: Project): void {
    const root = project.repo.root;
    const notify = (uri: vscode.Uri) => {
      if (!isIgnoredChange(path.relative(root, uri.fsPath))) this.scheduler?.notify();
    };
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(root), "**/*"),
    );
    this.disposables.push(
      watcher,
      watcher.onDidCreate(notify),
      watcher.onDidChange(notify),
      watcher.onDidDelete(notify),
    );
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
      : startNativeWatch(project.vault.root, notify);
    const stop =
      native ?? startPolling(project.vault, { skipFolder: isExcludedFolder, onChange: notify });
    this.disposables.push({ dispose: stop });
  }

  syncNow(options: { allowBulk?: boolean } = {}): Promise<void> {
    return this.scheduler?.syncNow(options) ?? Promise.resolve();
  }

  pause(): void {
    this.scheduler?.pause();
  }

  resume(): Promise<void> {
    return this.scheduler?.resume() ?? Promise.resolve();
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
