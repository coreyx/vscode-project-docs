# @specdevship/project-docs-core

The sync engine behind [Project Docs](https://marketplace.visualstudio.com/items?itemName=specdevship.project-docs): it keeps a repo's docs folder and a folder in an Obsidian vault in sync on the same machine. The VS Code extension, the `project-docs` command line and the Obsidian plugin all use it, so they apply exactly the same rules.

It provides:

- the three-way sync planner and its executor, with a journal so an interrupted pass can be finished safely;
- the privacy guards that keep private notes, their names and real values out of the repo;
- the link records (`.project-docs.json`, `.project-docs.local.json`) and the link note;
- per-file sync rules read from frontmatter;
- a [PRIVATE.md](https://github.com/coreyx/private-md-standard) decoder that passes the standard's conformance cases;
- wikilink conversion, line-ending handling, and the cross-process lock.

It's published for the extension, the plugin and the CLI. Most people want the [extension](https://marketplace.visualstudio.com/items?itemName=specdevship.project-docs) or [the command line](https://www.npmjs.com/package/@specdevship/project-docs-cli) instead.

Requires Node 22 or newer. It's an ES module.

## Stability

Versions before 1.0 are prereleases: any `0.x` release may change the API. Pin an exact version.

## Entry points

The package root exports everything, including the engine. The Obsidian plugin never runs sync passes, so the parts it needs also have their own entry points:

| Import                                     | What it's for                                                                                  |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `@specdevship/project-docs-core/rules`     | Reading and changing a note's sync rule and other frontmatter properties.                      |
| `@specdevship/project-docs-core/records`   | The link records and the link note: reading them, and the `obsidian://` and `vscode://` links. |
| `@specdevship/project-docs-core/privatemd` | Decoding PRIVATE.md, restoring real values, and finding or replacing real values.              |
| `@specdevship/project-docs-core/guards`    | The private-subfolder test and the private-files list format.                                  |
| `@specdevship/project-docs-core/links`     | Finding, resolving and converting links.                                                       |
| `@specdevship/project-docs-core/status`    | The files the engine and the plugin share in `<vault folder>/.project-docs/`.                  |

### Sync rules (`/rules`)

- `readRule(text)` returns the note's `project-docs` rule (`"sync"` when there's none), or an `InvalidRule` with a message; test it with `isInvalidRule`.
- `setRule(text, rule)` changes only the `project-docs` property and leaves the rest of the file byte-identical.
- `SYNC_RULES` lists the rules; `RULE_PROPERTY` is the property's name.
- `readProperty`, `setProperties` and `removeProperties` do the same for any frontmatter property. They throw `FrontmatterError` on frontmatter they can't edit safely.

### Link records and the link note (`/records`)

- `readLink(repoRoot)` reads both records and reports whether the repo is linked.
- `readLinkNoteRepo(linkNotePath)` returns the repo path a link note records.
- `obsidianOpenUri(notePath, wsl)` and `vscodeOpenUri(repoPath, wsl)` build the links between the two apps, including from a WSL repo.
- `validateCommitted` and `validateLocal` check a record against its schema.

### PRIVATE.md (`/privatemd`)

- `parsePlaceholders(text)` reads the `## Placeholders` table into a mapping, and throws `PrivateMdError` (with a `kind`) for anything the standard calls an error. `loadPlaceholders(file)` does the same for a file path.
- `restore(text, mapping)` replaces each placeholder with its real value, applying the standard's boundary rule.
- `findRealValues(text, mapping)` and `findRealValueRanges(text, mapping)` find real values in text; their results name placeholders only, never the values. `replaceRealValues(text, mapping)` puts the placeholders back.
- `placeholderPattern(placeholder)` is the decoder's own regular expression source for one placeholder, with the standard's boundary rule, for checking that a rendered view has no placeholders left.

### Private files (`/guards`)

- `inPrivateSubfolder(key, privateSubfolder)` tells whether a vault key is inside the private subfolder.
- `parsePrivateFilesList(text)` reads `private-files.json`. A list it can't read comes back as `INVALID_PRIVATE_FILES`, and the engine then holds back every attachment.

### Links (`/links`)

`findLinks`, `createResolver` and `convertWikilinks` find a note's links, resolve them the way Obsidian does, and convert wikilinks to Markdown links.

### Shared vault files (`/status`)

- `statusFilePath(vaultFolderPath)` and `parseStatusFile(text)` read the engine's `status.json`: one item per problem, each with a `kind`, `path`, `message`, `reasons` and an optional `fix`. It never contains real values. `parseStatusFile` returns `null` for a missing or unreadable file, or one in a newer format.
- `privateFilesPath(vaultFolderPath)` and `serializePrivateFilesList(files)` write the private-files list, which the plugin owns. The engine only reads it.
- `confirmationsPath(vaultFolderPath)` and `serializeConfirmations(files)` write `confirmations.json`: the notes the user agreed in Obsidian may stop being private, each as `{ path, sha256 }`. The hash is `markdownHash(text)` of the note's content at that moment, also exported here. The engine syncs a held note only while its path and hash match an entry, so a confirmation never covers a later edit. Remove an entry once its note has synced or been deleted.

## License

MIT
