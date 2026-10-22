/**
 * Setting up PRIVATE.md (REQ-15.0.3) and the standard's commit hooks (REQ-15.0.4, design decision
 * 16). The hooks come from the standard's own scripts, bundled with the extension, so there is
 * one checker to keep in step with the standard rather than two.
 */
import { execFile } from "node:child_process";
import { stat, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import * as vscode from "vscode";
import { ensureGitIgnored } from "@specdevship/project-docs-core";
import { GITIGNORE_ENTRIES, privateExampleTemplate, privateMdTemplate } from "./templates.js";

const run = promisify(execFile);

const exists = (file: string) =>
  stat(file).then(
    () => true,
    () => false,
  );

/** What "Set up PRIVATE.md" did. */
export type SetupResult = "created" | "exists";

/**
 * Creates PRIVATE.md with an empty placeholder table and PRIVATE.example.md, and gitignores
 * PRIVATE.md and private copies. An existing file is never overwritten.
 */
export async function setupPrivateMd(repoRoot: string): Promise<SetupResult> {
  const privateMd = path.join(repoRoot, "PRIVATE.md");
  if (await exists(privateMd)) return "exists";
  const eol = process.platform === "win32" ? "\r\n" : "\n";
  await writeFile(privateMd, privateMdTemplate(eol), { flag: "wx" });
  const example = path.join(repoRoot, "PRIVATE.example.md");
  if (!(await exists(example))) await writeFile(example, privateExampleTemplate(eol));
  for (const entry of GITIGNORE_ENTRIES) await ensureGitIgnored(repoRoot, entry);
  return "created";
}

/** A Python 3 the hooks can run with: the command, and any arguments before the script. */
interface Python {
  readonly command: string;
  readonly args: readonly string[];
}

/** Finds Python 3 the way the installed hooks do, plus Windows' `py` launcher. */
async function findPython(): Promise<Python | null> {
  const candidates: Python[] = [
    { command: "python3", args: [] },
    { command: "python", args: [] },
    ...(process.platform === "win32" ? [{ command: "py", args: ["-3"] }] : []),
  ];
  for (const candidate of candidates) {
    try {
      const { stdout, stderr } = await run(candidate.command, [...candidate.args, "--version"], {
        timeout: 10_000,
      });
      // Python 2 printed its version to stderr.
      if (/Python 3\./.test(stdout + stderr)) return candidate;
    } catch {
      // Not installed, or not runnable here; try the next one.
    }
  }
  return null;
}

/** What installing the hooks did. */
export type HooksResult =
  | { readonly outcome: "installed"; readonly report: string }
  | { readonly outcome: "no-python" }
  | { readonly outcome: "failed"; readonly message: string };

/** Runs the standard's `install-hooks`, which copies the checker into the repo and adds hooks. */
export async function installHooks(repoRoot: string, scriptsDir: string): Promise<HooksResult> {
  const python = await findPython();
  if (!python) return { outcome: "no-python" };
  try {
    const { stdout, stderr } = await run(
      python.command,
      [...python.args, path.join(scriptsDir, "private_md.py"), "install-hooks", repoRoot],
      { cwd: repoRoot, timeout: 60_000 },
    );
    return { outcome: "installed", report: `${stdout}${stderr}`.trim() };
  } catch (error) {
    const failure = error as { stderr?: string; message: string };
    return { outcome: "failed", message: failure.stderr?.trim() || failure.message };
  }
}

/** Remembers, per project, that the hook offer was answered (REQ-15.0.4). */
const offerKey = (projectId: string) => `projectDocs.hooksOfferAnswered.${projectId}`;

/** Registers the setup and hook commands, and makes the one-time hook offer. */
export class PrivateMdSetup implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[];
  private readonly output = vscode.window.createOutputChannel("Project Docs");

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly repoRoot: () => string | undefined,
  ) {
    this.disposables = [
      this.output,
      vscode.commands.registerCommand("projectDocs.setupPrivateMd", () => this.setup()),
      vscode.commands.registerCommand("projectDocs.installHooks", () => this.install()),
    ];
  }

  private get scriptsDir(): string {
    return path.join(this.context.extensionPath, "resources", "private-md");
  }

  /** "Set up PRIVATE.md": creates the files, opens PRIVATE.md, then offers the hooks. */
  async setup(): Promise<SetupResult | undefined> {
    const repo = this.repoRoot();
    if (!repo) {
      void vscode.window.showErrorMessage("Open the repo's folder first, then set up PRIVATE.md.");
      return undefined;
    }
    const result = await setupPrivateMd(repo);
    if (result === "exists") {
      void vscode.window.showInformationMessage("This repo already has a PRIVATE.md.");
    }
    await vscode.window.showTextDocument(vscode.Uri.file(path.join(repo, "PRIVATE.md")));
    return result;
  }

  /** Installs the hooks and reports what the standard's script did. */
  async install(): Promise<HooksResult | undefined> {
    const repo = this.repoRoot();
    if (!repo) return undefined;
    const result = await installHooks(repo, this.scriptsDir);
    switch (result.outcome) {
      case "installed":
        this.output.appendLine(result.report);
        void vscode.window
          .showInformationMessage(
            "PRIVATE.md commit hooks are set up: commits containing real values are blocked.",
            "Show Details",
          )
          .then((choice) => (choice ? this.output.show() : undefined));
        break;
      case "no-python":
        void vscode.window.showWarningMessage(
          "The PRIVATE.md commit hooks need Python 3, which wasn't found, so nothing was installed. Install Python 3, then run Project Docs: Install PRIVATE.md Commit Hooks.",
        );
        break;
      case "failed":
        this.output.appendLine(result.message);
        void vscode.window.showErrorMessage(
          `Project Docs couldn't install the commit hooks: ${result.message}`,
        );
        break;
    }
    return result;
  }

  /**
   * Offers the hooks once per project when the linked repo has a PRIVATE.md and no hooks yet.
   * Answering either way, including "Don't Ask Again", ends the offer for good (REQ-15.0.4).
   */
  async offer(projectId: string): Promise<void> {
    const repo = this.repoRoot();
    if (!repo || this.context.globalState.get<boolean>(offerKey(projectId))) return;
    if (!(await exists(path.join(repo, "PRIVATE.md")))) return;
    if (await exists(path.join(repo, ".githooks", "pre-commit"))) return;
    const choice = await vscode.window.showInformationMessage(
      "Install the PRIVATE.md commit hooks? They block any commit that contains a real value from PRIVATE.md.",
      "Install",
      "Don't Ask Again",
    );
    if (choice === undefined) return;
    await this.context.globalState.update(offerKey(projectId), true);
    if (choice === "Install") await this.install();
  }

  dispose(): void {
    for (const disposable of this.disposables) disposable.dispose();
  }
}
