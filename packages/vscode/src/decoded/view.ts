/**
 * Decoded views (REQ-14): a coded doc shown with its real values, as a read-only virtual document
 * and as a Markdown preview, never as a file (design decision 14). An editor-title toggle and a
 * status bar indicator always say which mode is shown.
 *
 * The documents come from a read-only file system provider rather than a content provider: VS
 * Code lets extensions edit a content provider's documents in memory, while a read-only file
 * system refuses every edit, from typing or from the API (REQ-14.0.3).
 */
import * as path from "node:path";
import * as vscode from "vscode";
import {
  PrivateMdError,
  loadPlaceholders,
  restore,
  type PrivateMdMapping,
} from "@specdevship/project-docs-core";
import type { SyncController } from "../sync/controller.js";
import { DECODED_SCHEME, MODE_TEXT, decodedUriParts } from "./naming.js";

/**
 * What opening a decoded view did: the document, with a note when PRIVATE.md maps nothing yet, or
 * the standard's error and nothing shown.
 */
export type DecodeResult =
  { readonly uri: vscode.Uri; readonly note?: string } | { readonly error: string };

/** Shown with a decoded view while PRIVATE.md's table is empty (REQ-15.0.6). */
export const NO_PLACEHOLDERS_NOTE =
  "PRIVATE.md has no placeholders yet, so the decoded view shows the doc as it is.";

/** Reads the repo's PRIVATE.md, or the standard's error explaining why it can't be used. */
async function mappingFor(repoRoot: string): Promise<PrivateMdMapping | { error: string }> {
  try {
    return await loadPlaceholders(path.join(repoRoot, "PRIVATE.md"));
  } catch (error) {
    if (error instanceof PrivateMdError) return { error: error.message };
    throw error;
  }
}

/** Why a decoded document can't be changed, shown when the user tries to type in one. */
const READ_ONLY_MESSAGE = new vscode.MarkdownString(
  "This decoded view shows real values from PRIVATE.md and can't be edited or saved. Edit the coded file instead.",
);

/** Serves decoded documents and keeps the toggle and the mode indicator in step. */
export class DecodedView implements vscode.FileSystemProvider, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.changed.event;
  /** When each open decoded document last changed, so VS Code sees a newer version and reloads. */
  private readonly mtimes = new Map<string, number>();
  private repoWatcher: { repo: string; watcher: vscode.FileSystemWatcher } | null = null;
  private readonly item = vscode.window.createStatusBarItem(
    "projectDocs.mode",
    vscode.StatusBarAlignment.Right,
    101,
  );
  private readonly disposables: vscode.Disposable[] = [this.changed, this.item];
  private readonly onPrivateMd = () => {
    void this.refreshMode();
    for (const document of vscode.workspace.textDocuments) {
      if (document.uri.scheme === DECODED_SCHEME) this.touch(document.uri);
    }
  };
  /** Whether the active editor's repo has a usable PRIVATE.md, for the toggle and tests. */
  available = false;

  constructor(private readonly controller: () => SyncController | null) {
    this.item.name = "Project Docs Decoded Mode";
    this.item.command = "projectDocs.toggleDecoded";
    const privateMd = vscode.workspace.createFileSystemWatcher("**/PRIVATE.md");
    this.disposables.push(
      vscode.workspace.registerFileSystemProvider(DECODED_SCHEME, this, {
        isCaseSensitive: true,
        isReadonly: READ_ONLY_MESSAGE,
      }),
      privateMd,
      privateMd.onDidCreate(this.onPrivateMd),
      privateMd.onDidChange(this.onPrivateMd),
      privateMd.onDidDelete(this.onPrivateMd),
      vscode.workspace.onDidChangeTextDocument((event) => this.onSourceEdit(event.document)),
      vscode.window.onDidChangeActiveTextEditor(() => void this.refreshMode()),
      vscode.commands.registerCommand("projectDocs.toggleDecoded", () => this.toggle()),
      vscode.commands.registerCommand("projectDocs.showDecoded", (uri?: vscode.Uri) =>
        this.open(uri ?? vscode.window.activeTextEditor?.document.uri),
      ),
      vscode.commands.registerCommand("projectDocs.showCoded", (uri?: vscode.Uri) =>
        this.showCoded(uri ?? vscode.window.activeTextEditor?.document.uri),
      ),
      vscode.commands.registerCommand("projectDocs.openDecodedPreview", (uri?: vscode.Uri) =>
        this.preview(uri ?? vscode.window.activeTextEditor?.document.uri),
      ),
    );
    void this.refreshMode();
  }

  /**
   * The repo a file belongs to, where PRIVATE.md lives: the linked repo when the file is in it,
   * otherwise its workspace folder. Decoding doesn't need a link, only a PRIVATE.md.
   */
  private repoOf(uri: vscode.Uri): string | null {
    const linked = this.controller()?.repoRoot;
    if (linked) {
      const relative = path.relative(linked, uri.fsPath);
      if (!relative.startsWith("..") && !path.isAbsolute(relative)) return linked;
    }
    return vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath ?? null;
  }

  /** The decoded document's URI for a source document. */
  static decodedUri(source: vscode.Uri): vscode.Uri {
    return vscode.Uri.from(decodedUriParts(source.path, source.toString()));
  }

  /** The source document behind a decoded one. */
  static sourceOf(decoded: vscode.Uri): vscode.Uri {
    return vscode.Uri.parse(decoded.query);
  }

  /**
   * The decoded text. If PRIVATE.md stops being usable while the view is open, it shows the error
   * instead: never coded text dressed as decoded, and never a partly decoded one (REQ-14.0.5).
   */
  private async decodedText(uri: vscode.Uri): Promise<string> {
    const source = DecodedView.sourceOf(uri);
    const repo = this.repoOf(source);
    if (!repo) return "This file isn't in an open folder, so it has no PRIVATE.md to decode with.";
    const mapping = await mappingFor(repo);
    if ("error" in mapping) return `Nothing is decoded: ${mapping.error}.`;
    const document = await vscode.workspace.openTextDocument(source);
    return restore(document.getText(), mapping);
  }

  private onSourceEdit(document: vscode.TextDocument): void {
    if (document.uri.scheme === DECODED_SCHEME) return;
    const decoded = DecodedView.decodedUri(document.uri).toString();
    const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === decoded);
    if (open) this.touch(open.uri);
  }

  /** Tells VS Code a decoded document changed, so an open one reloads. */
  private touch(uri: vscode.Uri): void {
    this.mtimes.set(uri.toString(), Date.now());
    this.changed.fire([{ type: vscode.FileChangeType.Changed, uri }]);
  }

  // The read-only file system. Only stat and readFile do anything; every write is refused.

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const mtime = this.mtimes.get(uri.toString()) ?? Date.now();
    this.mtimes.set(uri.toString(), mtime);
    const size = new TextEncoder().encode(await this.decodedText(uri)).byteLength;
    return {
      type: vscode.FileType.File,
      ctime: mtime,
      mtime,
      size,
      permissions: vscode.FilePermission.Readonly,
    };
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    return new TextEncoder().encode(await this.decodedText(uri));
  }

  watch(): vscode.Disposable {
    // Changes are reported through touch(), from the source document and PRIVATE.md watchers.
    return new vscode.Disposable(() => undefined);
  }

  readDirectory(): [string, vscode.FileType][] {
    return [];
  }

  createDirectory(uri: vscode.Uri): void {
    throw vscode.FileSystemError.NoPermissions(uri);
  }

  writeFile(uri: vscode.Uri): void {
    throw vscode.FileSystemError.NoPermissions(uri);
  }

  delete(uri: vscode.Uri): void {
    throw vscode.FileSystemError.NoPermissions(uri);
  }

  rename(uri: vscode.Uri): void {
    throw vscode.FileSystemError.NoPermissions(uri);
  }

  /** Opens the decoded view of a Markdown document, or says why it can't (REQ-14.0.2). */
  async open(source: vscode.Uri | undefined): Promise<DecodeResult> {
    if (!source || source.scheme === DECODED_SCHEME) {
      return { error: "Open a Markdown doc to decode it." };
    }
    const repo = this.repoOf(source);
    const mapping = repo ? await mappingFor(repo) : { error: "the file isn't in an open folder" };
    if ("error" in mapping) {
      void vscode.window.showErrorMessage(`Project Docs can't decode: ${mapping.error}.`);
      return { error: mapping.error };
    }
    const uri = DecodedView.decodedUri(source);
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.languages.setTextDocumentLanguage(document, "markdown");
    await vscode.window.showTextDocument(document, { preview: false });
    if (mapping.size === 0) {
      void vscode.window.showInformationMessage(NO_PLACEHOLDERS_NOTE);
      return { uri, note: NO_PLACEHOLDERS_NOTE };
    }
    return { uri };
  }

  private async showCoded(uri: vscode.Uri | undefined): Promise<void> {
    if (uri?.scheme !== DECODED_SCHEME) return;
    await vscode.window.showTextDocument(DecodedView.sourceOf(uri), { preview: false });
  }

  /** Switches the active editor between coded and decoded. */
  private async toggle(): Promise<DecodeResult | undefined> {
    const uri = vscode.window.activeTextEditor?.document.uri;
    if (uri?.scheme === DECODED_SCHEME) {
      await this.showCoded(uri);
      return undefined;
    }
    return this.open(uri);
  }

  /** Opens the decoded text in VS Code's Markdown preview. */
  private async preview(uri: vscode.Uri | undefined): Promise<void> {
    if (!uri) return;
    const decoded = uri.scheme === DECODED_SCHEME ? { uri } : await this.open(uri);
    if ("uri" in decoded) await vscode.commands.executeCommand("markdown.showPreview", decoded.uri);
  }

  /** Watches the linked repo's PRIVATE.md, which can sit outside every workspace folder. */
  private watchLinkedRepo(): void {
    const repo = this.controller()?.repoRoot ?? null;
    if (this.repoWatcher?.repo === repo) return;
    this.repoWatcher?.watcher.dispose();
    this.repoWatcher = null;
    if (!repo) return;
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(repo), "PRIVATE.md"),
    );
    watcher.onDidCreate(this.onPrivateMd);
    watcher.onDidChange(this.onPrivateMd);
    watcher.onDidDelete(this.onPrivateMd);
    this.repoWatcher = { repo, watcher };
  }

  /** Updates the mode indicator and the toggle's context key for the active editor. */
  async refreshMode(): Promise<void> {
    this.watchLinkedRepo();
    const uri = vscode.window.activeTextEditor?.document.uri;
    if (uri?.scheme === DECODED_SCHEME) {
      this.available = true;
      this.item.text = MODE_TEXT.decoded;
      this.item.tooltip = "Real values from PRIVATE.md are shown. Click to show the coded text.";
      this.item.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
      this.item.show();
    } else {
      const repo = uri?.scheme === "file" ? this.repoOf(uri) : null;
      const markdown = vscode.window.activeTextEditor?.document.languageId === "markdown";
      this.available = Boolean(repo && markdown && !("error" in (await mappingFor(repo))));
      if (this.available) {
        this.item.text = MODE_TEXT.coded;
        this.item.tooltip = "Placeholders are shown. Click to show the real values.";
        this.item.backgroundColor = undefined;
        this.item.show();
      } else {
        this.item.hide();
      }
    }
    await vscode.commands.executeCommand("setContext", "projectDocs.decodable", this.available);
  }

  /** The status bar's mode text while it's shown, for tests. */
  get modeText(): string | undefined {
    return this.available ? this.item.text : undefined;
  }

  dispose(): void {
    this.repoWatcher?.watcher.dispose();
    for (const disposable of this.disposables) disposable.dispose();
  }
}
