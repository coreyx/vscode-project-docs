// Integration tests run inside a real VS Code. VSCODE_TEST_VERSION picks the version; the default is
// the engine floor from package.json, so tests prove the extension works on the oldest supported VS
// Code.
import { defineConfig } from "@vscode/test-cli";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const workspace = path.join(tmpdir(), "project-docs-test-workspace");
mkdirSync(workspace, { recursive: true });

export default defineConfig({
  files: "out/test/integration/**/*.test.cjs",
  version: process.env.VSCODE_TEST_VERSION ?? "1.134.0",
  workspaceFolder: workspace,
  launchArgs: ["--disable-extensions", "--disable-workspace-trust"],
  mocha: { ui: "bdd", timeout: 60_000 },
});
