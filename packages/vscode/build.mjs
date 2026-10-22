// Bundles the extension's two entry points: the Node entry that does all the work, and the web
// stub that only tells browser-based VS Code users the extension needs desktop VS Code.
// With --tests, also bundles the integration tests that run inside VS Code.
import { build } from "esbuild";
import { readdirSync } from "node:fs";

// "source" builds straight from the core's TypeScript, so the core needn't be compiled first.
const shared = { bundle: true, sourcemap: true, external: ["vscode"], conditions: ["source"] };

const builds = [
  build({
    ...shared,
    entryPoints: ["src/extension.ts"],
    outfile: "dist/extension.cjs",
    platform: "node",
    target: "node22",
    format: "cjs",
  }),
  build({
    ...shared,
    entryPoints: ["src/web.ts"],
    outfile: "dist/web.js",
    platform: "browser",
    target: "es2022",
    format: "cjs",
  }),
];

if (process.argv.includes("--tests")) {
  const tests = readdirSync("test/integration")
    .filter((name) => name.endsWith(".test.ts"))
    .map((name) => `test/integration/${name}`);
  builds.push(
    build({
      ...shared,
      // Mocha and the VS Code API are provided by the test host.
      external: ["vscode", "mocha"],
      entryPoints: tests,
      outdir: "out/test/integration",
      outExtension: { ".js": ".test.cjs" },
      entryNames: "[name]",
      platform: "node",
      target: "node22",
      format: "cjs",
    }),
  );
}

await Promise.all(builds);
