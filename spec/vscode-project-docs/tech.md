---
status: approved
---

# Project Docs Tech Stack

## Summary

The whole product is written in TypeScript:
- **Shared core:** sync engine, merge, rules, link formats and the PRIVATE.md decoder. Plain Node (22+) with no VS Code or Obsidian dependency.
- **Command-line tool:** a thin wrapper over the core.
- **VS Code extension:** hosts the engine and supplies file watching, trash and UI through VS Code's API.
- **Obsidian plugin:** in its own repo, consumes the core from npm.
- **Build and test:** everything is bundled with esbuild and tested with Vitest (plus fast-check for randomized sync scenarios and `@vscode/test-cli` for the extension). CI runs on Windows, macOS, Linux and WSL.
- **Storage:** the engine's state is plain files in a per-user application-data folder. There are no databases and no native modules.

## Decisions

### Language
**Choice:** TypeScript (strict mode) everywhere.
**Why:**
- VS Code extensions and Obsidian plugins are both JavaScript runtimes, so one language lets the core be shared byte for byte between the extension, the plugin and the CLI (REQ-2, REQ-14, REQ-18).
- Strict typing matters most where data loss is at stake (REQ-5, REQ-19).

**Alternatives considered:**
- **Rust or Go for the engine, compiled to WebAssembly or a sidecar binary:** faster, but adds a second toolchain and per-platform binaries in the VS Code package, for performance targets (REQ-20) that Node meets easily.

### Repository layout and package manager
**Choice:** npm workspaces in `vscode-project-docs`, with three packages:
- `packages/core`;
- `packages/cli`;
- `packages/vscode` (the extension).

The plugin lives in `obsidian-project-docs` and installs `@specdevship/project-docs-core` from npm.

**Why:**
- The core and the CLI version together with the engine they share.
- npm is what `vsce` (the extension packager) and Obsidian's sample plugin assume, so there are no workarounds.
- The Obsidian store needs the plugin in its own repo (product constraint).

**Alternatives considered:**
- **pnpm:** faster installs, but `vsce` needs extra flags with pnpm's linking. That isn't worth it for three packages.
- **A single package with no workspaces:** would force the plugin to depend on extension code.

### Package names on npm
**Choice:** `@specdevship/project-docs-core` and `@specdevship/project-docs-cli`, under a `specdevship` npm organization. Project Docs is part of the SpecDevShip project. The CLI's command is still `project-docs`.

**Why:**
- The plugin must install the core from npm (REQ-14.0.1 needs the same decoder on both sides), and the CLI needs an install name (REQ-18).
- The SpecDevShip scope groups Project Docs with the rest of that project, and leaves room for other SpecDevShip packages beside it.

**Alternatives considered:**
- **`@project-docs`:** already taken on npm.
- **The maintainer's personal scope (`@coreyx`):** needs no organization, but ties the packages to one account rather than to the project.
- **Unscoped `project-docs-core` / `project-docs-cli`:** free today, but not reserved.

### Bundling
**Choice:** esbuild for the extension, the CLI and the plugin.
**Why:**
- VS Code's guidance and Obsidian's sample plugin both use esbuild.
- A single bundled file per target keeps the extension package small and loads quickly (REQ-20).
- It handles the ESM-only Markdown libraries below.

**Alternatives considered:** webpack and Rollup. Both are slower, and neither adds anything here.

### Runtime targets
**Choice:**
- **Core and CLI:** Node 22 or newer.
- **Extension:** a VS Code engine floor set to the stable release six months before the first publish.
- **Plugin:** desktop only (`isDesktopOnly: true`), with a `minAppVersion` set the same way.

**Why:**
- Node 22 is the oldest maintained Node LTS line, and recent VS Code ships a newer Node in its Electron, so the core's Node APIs are available everywhere it runs.
- The plugin needs Node's filesystem to read PRIVATE.md from the repo (REQ-14.0.6). The repo isn't on a phone, so desktop-only matches the product's platform constraint.
- Browser-based VS Code is declined at activation (REQ-21.0.3).

**Alternatives considered:** supporting Node 20 for the CLI. Node 20 is past end of life, so it isn't worth constraining the code for it.

### File watching
**Choice:**
- **The extension** uses VS Code's `workspace.createFileSystemWatcher` with a `RelativePattern` for both the repo docs folder and the vault folder, which VS Code supports outside the workspace.
- **The core** adds its own polling scanner, used automatically where native watching is unreliable (a WSL repo watching `/mnt/<drive>`, network drives), plus the periodic full rescan.
- **The CLI** needs no watcher, since it runs one pass and exits.

**Why:**
- REQ-4 needs native watching, a polling fallback and a safety rescan.
- VS Code's watcher is already per-platform and maintained by the VS Code team, and runs inside the WSL extension host when the repo is in WSL.
- The scanner and rescan are needed anyway, so a third-party watcher would add nothing.

**Alternatives considered:**
- **chokidar:** maintained and widely used, but it duplicates VS Code's watcher in the extension and isn't needed by the CLI.
- **@parcel/watcher:** uses native binaries, which would force platform-specific extension packages.

### Three-way merge
**Choice:** `node-diff3` (MIT, 3.2.1, published June 2026).
**Why:**
- REQ-5 needs a line-level three-way merge against the base, with conflict regions that can be preserved and handed to a merge UI.
- `node-diff3` provides `merge`/`diff3Merge` with explicit conflict hunks, has no dependencies, and is widely used.

**Alternatives considered:**
- **`diff` (jsdiff):** its merge support is less complete.
- **Writing a diff3:** well understood, but untested code in the most data-critical path.

**Risk:** a single maintainer. The library is small and stable, and could be vendored or forked if it goes unmaintained.

### Conflict resolution UI
**Choice:**
- **First choice:** open VS Code's merge editor through the `_open.mergeEditor` command, the one VS Code's own Git extension uses, with the base, the repo version and the vault version.
- **Fallback:** if that command is missing or rejects its arguments, write a working copy with standard conflict markers outside both linked folders and open it. VS Code's built-in conflict decorations then offer "Accept Current / Incoming / Both", and a "Resolve" action finishes the conflict.

**Why:**
- REQ-5.0.3 asks for VS Code's merge editor.
- No public API opens it on arbitrary files, so the fallback keeps conflict resolution working if the internal command changes.

**Alternatives considered:**
- **The conflict-marker flow only:** stable, but a worse experience than the merge editor.
- **A custom webview merge UI:** a lot of work to reimplement something VS Code already has.

### Frontmatter
**Choice:** `yaml` (eemeli/yaml, ISC, 2.9.1) using its Document API. Only the text between the frontmatter delimiters is edited, and the rest of the file is copied through unchanged.
**Why:**
- REQ-9.2 requires that setting a rule changes only the `project-docs` property, leaving the rest of the file byte-identical.
- The Document API keeps comments, ordering and formatting of the other properties.

**Alternatives considered:**
- **gray-matter:** re-serializes the whole block and is barely maintained.
- **Obsidian's `processFrontMatter`:** available only inside the plugin, and it also reformats.

### Markdown link handling
**Choice:**
- `mdast-util-from-markdown` with `micromark-extension-gfm` and `micromark-extension-frontmatter` finds the code spans, code blocks, frontmatter and existing Markdown links, with exact positions.
- A small tokenizer of the core's own handles Obsidian's wikilink and embed syntax outside those ranges.
- Conversions are applied as positional text edits, so nothing else in the file is reformatted.

**Why:**
- REQ-12 must convert wikilinks without touching links inside code, or reformatting the document.
- REQ-13 must find every link target to check for private or out-of-folder links.

**Alternatives considered:**
- **remark with a wikilink plugin:** the available wikilink extensions model Obsidian's syntax incompletely (aliases with anchors, embeds, block references), and re-serializing through remark would reformat files.
- **Regex only:** gets code spans wrong.

### PRIVATE.md decoder
**Choice:** a TypeScript port of the standard's reference implementation inside the core. It uses JavaScript Unicode regexes (`[\p{L}\p{N}]` for "letter or digit in any script"), and is verified against the standard's conformance suite in CI.
**Why:**
- REQ-14.0.1 requires exact conformance.
- The core must run in the extension, the plugin and the CLI, so it can't shell out to Python.

**Alternatives considered:** calling the Python reference script. That needs Python on every machine and isn't available inside Obsidian.

**Risk:** JavaScript's `\p{L}\p{N}` and Python's `str.isalnum()` may disagree on rare characters. The conformance suite is the judge. Any disagreement found becomes a new conformance case and a clarification in the standard.

### Engine state storage
**Choice:** plain files in a per-user application-data folder: `%APPDATA%\project-docs`, `~/Library/Application Support/project-docs`, or `$XDG_DATA_HOME/project-docs`. One folder per project id holds:
- a content-addressed store of bases and conflict versions (files named by SHA-256);
- an index of paths to base hashes, written atomically (write to a temporary file, then rename);
- a journal of the pending pass.

**Why:**
- REQ-19.0.2 puts state outside both folders.
- REQ-19.0.3 needs crash-safe passes.
- The CLI and the extension must share the same state for REQ-18 to be correct. That rules out VS Code's private `globalStorageUri`, which the CLI can't find reliably.

**Alternatives considered:**
- **SQLite (`node:sqlite` or a native module):** transactional, but either a native binary or a runtime-dependent API across VS Code's Electron, Obsidian's Electron and Node.
- **VS Code's global storage:** not shared with the CLI.

### Engine lock
**Choice:** a lock file of the core's own in the state folder. It's created with exclusive-create (`wx`), records the process id, host, owner (VS Code or the CLI) and a heartbeat timestamp, and is treated as stale when the heartbeat is older than 30 seconds or the process is gone.
**Why:**
- REQ-19.0.1 needs one engine per link across VS Code windows and CLI runs, released if its holder dies.
- REQ-18.0.2 needs to name the holder.
- The state folder is always on a local disk, where exclusive-create is reliable.

**Alternatives considered:** `proper-lockfile`. It works, but has had no release in years and doesn't record who holds the lock.

### Trash
**Choice:**
- **Repo side:** VS Code's `workspace.fs.delete(uri, { useTrash: true })` in the extension, and `trash` (sindresorhus, MIT, 10.1.1) in the CLI.
- **Vault side:** files are moved into the vault's `.trash` folder, which is Obsidian's own trash.

**Why:** REQ-6.0.3 requires recoverable deletes on both sides.

**Alternatives considered:** a trash folder inside the engine's state. It's recoverable, but not where people look.

### WSL support
**Choice:** the extension runs as a workspace extension, so inside WSL when the repo is in WSL. Paths are translated with `wslpath` in WSL, and with the `\\wsl.localhost\<distro>\` form on Windows (REQ-2.0.4). Native watching is replaced by polling for vault paths under `/mnt/`.
**Why:** REQ-2.0.4, REQ-4.0.2 and REQ-16.0.1 need WSL with the repo and the vault on opposite sides.

### Testing
**Choice:**
- **Vitest** with V8 coverage for core and CLI unit and integration tests.
- **fast-check** for property-based tests that interleave edits, renames, deletes and crashes on both sides against real temporary folders.
- **`@vscode/test-cli` / `@vscode/test-electron`** for extension integration tests.
- **GitHub Actions** on `windows-latest`, `macos-latest` and `ubuntu-latest`, plus a WSL job on Windows.
- The plugin's tests live in its own repo.

**Why:**
- REQ-5.4 calls for randomized interleaving tests.
- REQ-19.2 calls for fault injection.
- REQ-16.1 calls for a three-OS CI and WSL.
- REQ-21.0.1 calls for coverage of 90–100% on critical modules, which V8 coverage measures without instrumentation overhead.

**Alternatives considered:**
- **Jest:** slower, and with weaker ESM support.
- **Mocha alone:** still used under `@vscode/test-cli` for the extension host, but Vitest is faster for the core.

### Command-line tool
**Choice:** a Node CLI in the `cli` package, built on Node's `util.parseArgs` with no framework. It's installed with npm or run with `npx`, and its command name is `project-docs`.
**Why:**
- REQ-18 needs `status`, `sync` and `where`.
- Agents' environments almost always have Node.
- `parseArgs` is built in, so there's no dependency for three commands.

**Alternatives considered:**
- **Standalone executables (Node single-executable applications):** no Node needed, but per-platform release artifacts. That's worth revisiting if users without Node ask for it.
- **commander or yargs:** unnecessary for three commands.

## Constraints & risks

- **`_open.mergeEditor` is an internal VS Code command.** It may change without notice. Mitigation: the conflict-marker fallback, and an integration test that fails loudly when the command's behavior changes.
- **Two Electron hosts.** The core runs in VS Code's Electron, Obsidian's Electron and plain Node. It must use only Node APIs present in all three. CI runs the core's tests on the oldest supported Node, and the plugin repo tests it inside Obsidian's runtime.
- **Unicode differences between the decoder and the Python reference.** The conformance suite is the arbiter (see the decoder decision).
- **Single-maintainer libraries:** `node-diff3` and `trash`. Both are small and MIT-licensed, and could be vendored if needed.
- **ESM-only Markdown libraries** (`mdast-util-from-markdown`, the micromark extensions). They are bundled by esbuild, so the extension and plugin load them as CommonJS bundles without issue. They can't be `require`d unbundled.
- **Licensing:** both repos are MIT-licensed. Every runtime dependency above is MIT or ISC, which is compatible.
- **npm organization:** the `specdevship` organization must be created on npm before the first publish. On 2026-10-22 the registry had no `specdevship` scope and neither package existed, but that only confirms the name is free once the organization is created. It's worth creating early.
