import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/** Modules where a bug can lose data or leak private content (tasks.md: 90–100% line coverage). */
const CRITICAL = "packages/core/src/{plan,exec,merge,guards,privatemd,state,lock}/**/*.ts";

export default defineConfig({
  // Resolve the core from its TypeScript sources, so tests never run against a stale build. Tests
  // run in Node through Vite's SSR resolver, which has its own conditions; both are set.
  resolve: {
    conditions: ["source"],
    // Extension unit tests run in plain Node, so `vscode` is replaced by a recording stand-in.
    alias: {
      vscode: fileURLToPath(new URL("./packages/vscode/test/unit/vscode-stub.ts", import.meta.url)),
    },
  },
  ssr: { resolve: { conditions: ["source"], externalConditions: ["source"] } },
  test: {
    include: [
      "packages/core/test/**/*.test.ts",
      "packages/cli/test/**/*.test.ts",
      "packages/vscode/test/unit/**/*.test.ts",
    ],
    coverage: {
      provider: "v8",
      include: [
        "packages/core/src/**/*.ts",
        "packages/cli/src/**/*.ts",
        "packages/vscode/src/**/*.ts",
      ],
      exclude: [
        "packages/cli/src/bin.ts",
        // Code that only runs inside VS Code is exercised by the integration suite
        // (`npm run test:vscode`), which Vitest's coverage can't see.
        "packages/vscode/src/extension.ts",
        "packages/vscode/src/web.ts",
        "packages/vscode/src/**/commands.ts",
      ],
      reporter: ["text", "html", "json-summary"],
      thresholds: {
        lines: 70,
        branches: 60,
        [CRITICAL]: { lines: 90, branches: 80 },
      },
    },
  },
});
