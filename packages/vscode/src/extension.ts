/**
 * Node entry point of the Project Docs extension.
 *
 * Linking, watching and the UI are registered here as they are built (spec/vscode-project-docs,
 * milestones 6 and 7).
 */
import type * as vscode from "vscode";

/** Called by VS Code when an activation event fires. */
export function activate(_context: vscode.ExtensionContext): void {}

/** Called by VS Code on shutdown; nothing to release yet. */
export function deactivate(): void {}
