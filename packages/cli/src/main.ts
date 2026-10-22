/**
 * The `project-docs` command (REQ-18): check and run sync from a terminal, so docs stay current when
 * only an agent is working in the repo and VS Code is closed.
 *
 *   project-docs status [--json]        what a pass would do, and any problems
 *   project-docs sync [--yes] [--json]  run one pass; --yes proceeds past the bulk guard
 *   project-docs where                   print the linked vault folder
 *
 * Exit codes (design.md, Interfaces): 0 success, 1 not linked or an error, 2 the bulk guard is
 * waiting for --yes, 3 another engine holds the lock.
 */
import { parseArgs } from "node:util";
import {
  CORE_VERSION,
  findRepoRoot,
  openProject,
  planPass,
  syncOnce,
  type Action,
  type LockInfo,
  type Notice,
  type OpenOptions,
  type Plan,
  type Project,
} from "@specdevship/project-docs-core";

export const EXIT = { ok: 0, error: 1, bulk: 2, locked: 3 } as const;

const USAGE = `Usage: project-docs <command> [options]

Commands:
  status    show what a sync pass would do, and any problems
  sync      run one sync pass
  where     print the linked vault folder

Options:
  --yes       let sync proceed past the bulk-change guard
  --json      print machine-readable output
  --version   print the version
  --help      print this help`;

/** Where output goes; injectable for tests. */
export interface Io {
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
  readonly cwd: string;
}

const defaultIo: Io = {
  out: (text) => console.log(text),
  err: (text) => console.error(text),
  cwd: process.cwd(),
};

/** Describes who holds the lock, for "another engine is syncing" (REQ-18.0.2). */
export function describeHolder(holder: LockInfo | null): string {
  if (!holder) return "another Project Docs process";
  if (holder.owner === "vscode")
    return `VS Code${holder.window ? ` (window ${holder.window})` : ""}`;
  return "another project-docs run";
}

function describeAction(action: Action): string {
  switch (action.type) {
    case "copy":
      return `copy ${action.key} from the ${action.from} to the ${action.from === "repo" ? "vault" : "repo"}`;
    case "writeBoth":
      return `write the merged ${action.key} to both sides`;
    case "rename":
      return `rename ${action.from} to ${action.to} in the ${action.side}`;
    case "trash":
      return `move ${action.key} to the ${action.side}'s trash`;
    case "conflict":
      return `keep the repo's ${action.key} and save the vault's version as a conflict`;
    case "adopt":
      return `record ${action.key} as in sync`;
    case "record":
      return `update the record for ${action.key}`;
  }
}

function printPlan(io: Io, plan: Plan, problems: readonly string[]): void {
  const changes = plan.actions.filter((a) => a.type !== "record" && a.type !== "adopt");
  if (changes.length === 0) io.out("Nothing to sync.");
  for (const action of changes) io.out(`  ${describeAction(action)}`);
  printNotices(io, plan.notices, problems);
}

function printNotices(io: Io, notices: readonly Notice[], problems: readonly string[]): void {
  for (const problem of problems) io.out(`! ${problem}`);
  for (const notice of notices) {
    io.out(`! ${notice.message}`);
    for (const reason of notice.reasons ?? []) io.out(`    ${reason}`);
  }
}

function json(io: Io, value: unknown): void {
  io.out(JSON.stringify(value, null, 2));
}

async function open(io: Io, options: OpenOptions): Promise<Project | number> {
  const repoRoot = await findRepoRoot(io.cwd);
  if (!repoRoot) {
    io.err(
      'This folder isn\'t in a repo linked to an Obsidian vault. Link it from VS Code with "Project Docs: Link to Obsidian".',
    );
    return EXIT.error;
  }
  const project = await openProject(repoRoot, options);
  if ("problem" in project) {
    io.err(project.message);
    return EXIT.error;
  }
  return project;
}

/** Runs the command line and resolves to the process exit status. */
export async function main(
  argv: readonly string[],
  io: Io = defaultIo,
  options?: OpenOptions,
): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: {
        yes: { type: "boolean", default: false },
        json: { type: "boolean", default: false },
        version: { type: "boolean", default: false },
        help: { type: "boolean", default: false },
      },
    });
  } catch (error) {
    io.err(`${(error as Error).message}\n\n${USAGE}`);
    return EXIT.error;
  }
  const { values, positionals } = parsed;
  const [command] = positionals;
  if (values.version) {
    io.out(CORE_VERSION);
    return EXIT.ok;
  }
  if (values.help || command === undefined) {
    io.out(USAGE);
    return EXIT.ok;
  }
  if (!["status", "sync", "where"].includes(command)) {
    io.err(`Unknown command: ${command}\n\n${USAGE}`);
    return EXIT.error;
  }

  const openOptions = options ?? (await defaultOpenOptions());
  const project = await open(io, openOptions);
  if (typeof project === "number") return project;

  if (command === "where") {
    io.out(project.local.vaultFolderPath);
    return EXIT.ok;
  }

  if (command === "status") {
    const { plan, problems } = await planPass(project);
    if (values.json)
      json(io, { actions: plan.actions, notices: plan.notices, bulk: plan.bulk, problems });
    else printPlan(io, plan, problems);
    return EXIT.ok;
  }

  const outcome = await syncOnce(project, { allowBulk: values.yes, owner: "cli" });
  switch (outcome.outcome) {
    case "locked": {
      const holder = describeHolder(outcome.heldBy);
      if (values.json) json(io, { outcome: "locked", heldBy: outcome.heldBy });
      else io.err(`Not syncing: ${holder} is already syncing this project.`);
      return EXIT.locked;
    }
    case "bulk": {
      const { destructive, threshold } = outcome.plan.bulk;
      if (values.json)
        json(io, { outcome: "bulk", bulk: outcome.plan.bulk, actions: outcome.plan.actions });
      else {
        io.err(
          `Not syncing: this pass would delete or overwrite ${destructive} files (more than ${threshold}). Review it with "project-docs status", then run "project-docs sync --yes".`,
        );
      }
      return EXIT.bulk;
    }
    case "synced": {
      const { result } = outcome;
      if (values.json) {
        json(io, {
          outcome: "synced",
          applied: result.applied,
          stale: result.stale,
          failed: result.failed,
          notices: outcome.plan.notices,
          problems: outcome.problems,
        });
      } else {
        io.out(`Synced: ${result.applied} change${result.applied === 1 ? "" : "s"} applied.`);
        if (result.stale > 0)
          io.out(`  ${result.stale} skipped because files changed meanwhile; run sync again.`);
        for (const failure of result.failed) io.out(`! ${failure.key}: ${failure.message}`);
        printNotices(io, outcome.plan.notices, outcome.problems);
      }
      return result.failed.length > 0 ? EXIT.error : EXIT.ok;
    }
  }
}

/** The CLI's trash for the repo side: the operating system's, via the `trash` package. */
async function defaultOpenOptions(): Promise<OpenOptions> {
  const { default: trash } = await import("trash");
  // glob: false means paths are never read as patterns, so file names with brackets are safe.
  return { repoTrash: (absolutePath) => trash(absolutePath, { glob: false }) };
}
