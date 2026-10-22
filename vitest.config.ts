import { defineConfig } from "vitest/config";

/** Modules where a bug can lose data or leak private content (tasks.md: 90–100% line coverage). */
const CRITICAL = "packages/core/src/{plan,exec,merge,guards,privatemd,state,lock}/**/*.ts";

export default defineConfig({
  // Resolve the core from its TypeScript sources, so tests never run against a stale build.
  resolve: { conditions: ["source"] },
  test: {
    include: ["packages/core/test/**/*.test.ts", "packages/cli/test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["packages/core/src/**/*.ts", "packages/cli/src/**/*.ts"],
      exclude: ["packages/cli/src/bin.ts"],
      reporter: ["text", "html", "json-summary"],
      thresholds: {
        lines: 70,
        branches: 60,
        [CRITICAL]: { lines: 90, branches: 80 },
      },
    },
  },
});
