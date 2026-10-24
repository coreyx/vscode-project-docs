# project-docs

The command line for [Project Docs](https://marketplace.visualstudio.com/items?itemName=specdevship.project-docs), which keeps a repo's docs folder and a folder in an Obsidian vault in sync on the same machine.

Use it when VS Code isn't running, such as when a coding agent is working in the repo on its own. It runs the same sync engine as the extension, with the same rules and safeguards.

## Install

Requires Node 22 or newer.

```sh
pnpm add --global @specdevship/project-docs-cli
```

Or with npm: `npm install --global @specdevship/project-docs-cli`. To run it without installing: `pnpm dlx @specdevship/project-docs-cli status` or `npx @specdevship/project-docs-cli status`.

The repo must already be linked; linking is done once, from VS Code, with **Project Docs: Link to Obsidian**.

## Commands

Run them anywhere inside a linked repo.

| Command               | What it does                                                        |
| --------------------- | ------------------------------------------------------------------- |
| `project-docs status` | Shows what a sync pass would do, and any problems. Changes nothing. |
| `project-docs sync`   | Runs one sync pass.                                                 |
| `project-docs where`  | Prints the linked vault folder's path on this machine.              |

| Option      | What it does                                          |
| ----------- | ----------------------------------------------------- |
| `--yes`     | Lets `sync` proceed past the bulk-change guard.       |
| `--json`    | Prints machine-readable output (`status` and `sync`). |
| `--version` | Prints the version.                                   |
| `--help`    | Prints the usage.                                     |

## Exit codes

| Code | Meaning                                                                                                                             |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------- |
| 0    | Done.                                                                                                                               |
| 1    | The repo isn't linked, or something failed; the message says what.                                                                  |
| 2    | `sync` stopped at the bulk-change guard: the pass would delete or overwrite many files. Check with `status`, then run `sync --yes`. |
| 3    | Another sync engine (VS Code, or another `project-docs` run) is syncing this link. The message names it.                            |

## What `sync` does and doesn't do

- It copies each side's changes to the other, follows renames, and merges edits to different parts of the same doc.
- Overlapping edits become a conflict, reported and left for you to resolve in VS Code. Nothing is overwritten.
- A file deleted on one side goes to the trash on the other.
- The vault folder mirrors the repo, so a file has the same path in both: the docs folder, plus the Markdown files at the top of the repo the link lists in `rootFiles` (`README.md`, `CHANGELOG.md` and `RELEASE_NOTES.md` unless changed). Nothing else in the repo syncs.
- Files git ignores, and anything in `node_modules`, don't sync in either direction, unless the link's `syncIgnored` setting lists them (`node_modules` never syncs). If a `.gitignore` can't be read, `sync` changes nothing and reports the file.
- Private notes, links to them, and real values from the repo's PRIVATE.md never reach the repo. A change held back for one of these is reported and stays in the vault.
- A note that was private and lost its marker is reported and stays in the vault until someone confirms it in VS Code or Obsidian. `sync` can't release it, `--yes` included.

## For agents

To find a project's vault notes, run `project-docs where`, or read `vaultFolderPath` from `.project-docs.local.json` at the repo root. Notes in that folder's `private` subfolder are vault-only: edit them in place, and they stay out of the repo. After editing synced docs, run `project-docs sync` so the other side catches up.

## License

MIT
