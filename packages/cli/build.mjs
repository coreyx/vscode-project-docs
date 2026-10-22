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
  banner: { js: "#!/usr/bin/env node" },
});
