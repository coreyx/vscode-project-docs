# @specdevship/project-docs-core

The sync engine behind [Project Docs](https://marketplace.visualstudio.com/items?itemName=specdevship.project-docs): it keeps a repo's docs folder and a folder in an Obsidian vault in sync on the same machine. The VS Code extension, the `project-docs` command line and the Obsidian plugin all use it, so they apply exactly the same rules.

It provides:

- the three-way sync planner and its executor, with a journal so an interrupted pass can be finished safely;
- the privacy guards that keep private notes, their names and real values out of the repo;
- the link records (`.project-docs.json`, `.project-docs.local.json`) and the link note;
- per-file sync rules read from frontmatter;
- a [PRIVATE.md](https://github.com/coreyx/private-md-standard) decoder that passes the standard's conformance cases;
- wikilink conversion, line-ending handling, and the cross-process lock.

It's published for the extension, the plugin and the CLI, and its API isn't stable yet. Most people want the [extension](https://marketplace.visualstudio.com/items?itemName=specdevship.project-docs) or [the command line](https://www.npmjs.com/package/@specdevship/project-docs-cli) instead.

Requires Node 22 or newer.

## License

MIT
