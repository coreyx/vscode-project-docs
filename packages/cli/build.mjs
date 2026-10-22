// Bundles the CLI into one executable ESM file, so `npx` and global installs start without
// resolving the core's dependencies at runtime.
import { build } from "esbuild";

await build({
  entryPoints: ["src/bin.ts"],
  outfile: "dist/project-docs.mjs",
  bundle: true,
  // Build straight from the core's TypeScript sources (its "source" export condition).
  conditions: ["source"],
  platform: "node",
  target: "node22",
  format: "esm",
  sourcemap: true,
  // Some bundled dependencies (yaml) are CommonJS and call require() for Node built-ins, which an
  // ESM bundle doesn't have; createRequire gives them a real one.
  banner: {
    js: [
      "#!/usr/bin/env node",
      'import { createRequire as __pdCreateRequire } from "node:module";',
      "const require = __pdCreateRequire(import.meta.url);",
    ].join("\n"),
  },
});
