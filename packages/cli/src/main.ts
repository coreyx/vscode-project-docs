/**
 * Entry point of the `project-docs` command.
 *
 * Only `--version` and `--help` exist so far; the `status`, `sync` and `where` commands are added
 * with the sync engine (spec/vscode-project-docs, TASK-17).
 */
import { CORE_VERSION } from "@specdevship/project-docs-core";

const USAGE = `Usage: project-docs <command>

Options:
  --version   print the version
  --help      print this help`;

/** Runs the command line and returns the process exit status. */
export function main(argv: readonly string[]): number {
  const [first] = argv;
  if (first === "--version") {
    console.log(CORE_VERSION);
    return 0;
  }
  if (first === undefined || first === "--help") {
    console.log(USAGE);
    return 0;
  }
  console.error(`Unknown command: ${first}\n\n${USAGE}`);
  return 1;
}
