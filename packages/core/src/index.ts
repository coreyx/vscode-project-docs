/**
 * Public API of `@specdevship/project-docs-core`.
 *
 * The core holds everything with a data-loss or privacy consequence (the planner, merge, guards,
 * PRIVATE.md decoder and link formats) so that the VS Code extension, the CLI and the Obsidian
 * plugin all run exactly the same logic. Modules are exported here as they are added.
 */

/** The core's package version, reported by the CLI and the extension in logs and `--version`. */
export const CORE_VERSION = "0.0.0";
