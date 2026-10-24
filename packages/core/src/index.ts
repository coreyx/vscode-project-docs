/**
 * Public API of `@specdevship/project-docs-core`.
 *
 * The core holds everything with a data-loss or privacy consequence (the planner, merge, guards,
 * PRIVATE.md decoder and link formats) so that the VS Code extension, the CLI and the Obsidian
 * plugin all run exactly the same logic. Modules are exported here as they are added.
 */

/** The core's package version, reported by the CLI and the extension in logs and `--version`. */
export const CORE_VERSION = "0.3.0";

export * from "./paths/index.js";

export * from "./sidefs/index.js";

export * from "./scan/index.js";

export * from "./state/index.js";

export * from "./lock/index.js";

export * from "./log/index.js";

export * from "./rules/index.js";

export * from "./privatemd/index.js";

export * from "./links/index.js";

export * from "./guards/index.js";

export * from "./status/index.js";

export * from "./merge/index.js";

export * from "./plan/index.js";

export * from "./exec/index.js";

export * from "./records/index.js";

export * from "./engine/index.js";

export * from "./watch/index.js";
