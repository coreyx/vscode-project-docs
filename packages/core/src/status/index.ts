/**
 * Vault metadata shared with the Obsidian plugin: `status.json`, `private-files.json`,
 * `confirmations.json` and `ignored-choices.json`.
 */
export * from "./status.js";
// The plugin hashes notes exactly as the engine does when it records a confirmation.
export { markdownHash, sha256 } from "../scan/index.js";
