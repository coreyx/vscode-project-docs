/**
 * Browser entry point. Project Docs reads and writes folders on the local disk, which
 * browser-based VS Code (vscode.dev, github.dev) can't do, so this entry only explains that.
 */
import * as vscode from "vscode";

export const DESKTOP_ONLY_MESSAGE =
  "Project Docs needs desktop VS Code: it syncs folders on your local disk, which browser-based VS Code can't access.";

/** Shows the desktop-only message once when activated in a browser host. */
export function activate(): void {
  void vscode.window.showInformationMessage(DESKTOP_ONLY_MESSAGE);
}
