// Bundles the extension's two entry points: the Node entry that does all the work, and the web
// stub that only tells browser-based VS Code users the extension needs desktop VS Code.
import { build } from "esbuild";

// "source" builds straight from the core's TypeScript, so the core needn't be compiled first.
const shared = { bundle: true, sourcemap: true, external: ["vscode"], conditions: ["source"] };

await Promise.all([
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
]);
