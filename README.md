# Project Docs

Keep a repo's docs folder and a folder in an Obsidian vault in sync, on the same machine, without ever silently overwriting an edit. Private notes stay out of the repo, and [PRIVATE.md](https://github.com/coreyx/private-md-standard) documents can be read with their real values on both sides.

Project Docs is part of SpecDevShip. It is under development; see [`spec/vscode-project-docs/`](spec/vscode-project-docs/) for the product definition, requirements and design.

## Packages

| Package                              | What it is                                                                                    |
| ------------------------------------ | --------------------------------------------------------------------------------------------- |
| [`packages/core`](packages/core)     | `@specdevship/project-docs-core`: the sync engine, rules, link formats and PRIVATE.md decoder |
| [`packages/cli`](packages/cli)       | `@specdevship/project-docs-cli`: the `project-docs` command                                   |
| [`packages/vscode`](packages/vscode) | The VS Code extension                                                                         |

The Obsidian plugin lives in [obsidian-project-docs](https://github.com/coreyx/obsidian-project-docs).

The user guide is the [extension's README](packages/vscode/README.md); the command line has [its own](packages/cli/README.md).

## Development

Requires Node 22 or newer and [pnpm](https://pnpm.io). The pnpm version is pinned in `package.json`, and pnpm switches to it on its own.

```sh
pnpm install
pnpm run build
pnpm test
pnpm run coverage
```

`pnpm --filter project-docs run test:vscode` runs the extension's integration tests in VS Code, and `pnpm --filter project-docs run package` builds a VSIX in `packages/vscode`.

## License

MIT
