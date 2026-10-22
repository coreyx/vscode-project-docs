// Integration tests run inside a real VS Code. VSCODE_TEST_VERSION picks the version; the default is
// the engine floor from package.json, so tests prove the extension works on the oldest supported VS
// Code.
import { defineConfig } from "@vscode/test-cli";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const workspace = path.join(tmpdir(), "project-docs-test-workspace");
mkdirSync(workspace, { recursive: true });
// VS Code puts its IPC socket in the user data folder. The runner's default folder sits deep in the
// checkout, which on macOS makes the socket path longer than Unix sockets allow (about 103 bytes).
const userData = path.join(tmpdir(), "pd-vscode-ud");

export default defineConfig({
  files: "out/test/integration/**/*.test.cjs",
  version: process.env.VSCODE_TEST_VERSION ?? "1.134.0",
  workspaceFolder: workspace,
  launchArgs: ["--disable-extensions", "--disable-workspace-trust", `--user-data-dir=${userData}`],
  mocha: { ui: "bdd", timeout: 60_000 },
});
