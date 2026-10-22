# Product: Project Docs

## Problem and motivation

Developers who work in both VS Code and Obsidian keep project documentation in two places that don't talk to each other:

- **In the repo**, docs are versioned with the code, reviewed in pull requests and read by coding agents.
- **In an Obsidian vault**, they're comfortable to read, linkable from the rest of your notes, and private, because the vault sits outside the repo.

Keeping both means copying files by hand. The copies drift, and nothing tells you which one is current. Private documentation has it worst: anything that can't be committed has no version control at all, so it's easy to forget where it lives and whether it's still up to date.

Project Docs turns a repo's docs folder and a vault folder into one body of documentation with two homes, kept in sync automatically. It also adds what neither home has on its own:

- **A persistent link between a repo and its vault folder, recorded on both sides.** A person or a coding agent working in the repo can find and maintain the documentation that lives outside it. From a vault note, they can follow the link back to the repo.
- **PRIVATE.md decoding on both sides.** You can read docs with their real values in VS Code or in Obsidian, switch between coded and decoded at any time, and always see which mode you're in. Real values never reach a tracked or synced file. See the [PRIVATE.md standard](https://github.com/coreyx/private-md-standard).
- **Per-file control through optional frontmatter** over whether and how each file syncs.
- **A home for project-private notes.** Notes that must never enter the repo live only in the project's vault folder, next to the synced docs and reachable through the same link. They can be versioned separately, for example with Obsidian's Git plugin pushing to a private Forgejo that is never mirrored to GitHub.

This is meant for nearly every project you work on, each with its own folder in one vault.

## Target users

- **Developers who write notes about their projects** and want those notes not to drift or get lost. That includes developers who keep docs in the repo, those who keep a "second brain" in Obsidian, and especially those who do both. The primary user is a developer working in both VS Code and Obsidian on the same machine.
- **Developers who document infrastructure or self-hosted setups.** Runbooks and setup plans for these name real hostnames, network names, IP addresses and paths. Those details have to be generalized before the docs can be committed, but the author still needs to read them with the real values. This is the audience for PRIVATE.md.
- **Coding agents working for those developers.** An agent in the repo needs to find the project's out-of-repo documentation, read it and keep it up to date. That means the repo-to-vault link must be a plain file an agent can read and follow, not state known only to the extension.
- **Later: users of VS Code forks** (Cursor, Windsurf, VSCodium), reached through the Open VSX registry. Not a priority for the first release.

## Value proposition

Today's options each give something up (dedicated sync plugins are compared under [Market and competitive context](#market-and-competitive-context)):

| Alternative | What it gives up |
|---|---|
| Copying by hand | Copies drift, and nothing tells you which is current. Private docs get lost. |
| Docs in the repo only | No comfortable reading, no links from your notes, and nowhere for private material. |
| Docs in the vault only | No versioning with the code, nothing for reviewers on GitHub, and agents can't see them. |
| Symlinks or junctions | Unfriendly to set up and not supported on every filesystem. No per-file control and no decoding. |
| General file sync (Syncthing, FreeFileSync) | No knowledge of frontmatter, PRIVATE.md or the repo-to-vault link. Conflicts end up as duplicate files. |

Project Docs keeps both homes current without ever silently overwriting an edit. It decodes private values safely on both sides and leaves a link that both people and agents can follow. It also works from the side developers and their agents are already on, VS Code and the repo, instead of only from inside Obsidian.

PRIVATE.md support is on by default and easy to discover, because redacting identifying details is a problem most people who document their setups run into without knowing a standard way to solve it.

## Goals and success criteria

Success is measured by reliability, not by adoption numbers. The release bar:

- **No copying by hand.** Once a project is linked, its docs stay current on both sides with no manual step.
- **No data loss, ever.** That holds under any sequence of edits on either side, renames, deletes, restarts, and either app being closed. Edits made on both sides either merge or show up as a visible conflict. Nothing is ever silently overwritten.
- **The same everywhere.** Behaviour is identical on Windows, macOS and Linux desktop, and under WSL with the repo and the vault on opposite sides.
- **Linking takes under a minute**, from opening a repo to having its docs in the vault.
- **Safe decoding.** PRIVATE.md decoded views work in both VS Code and Obsidian. The current mode (coded or decoded) is always visible, real values never reach a tracked or synced file, and any error shows an error instead of a half-decoded view.
- **Nothing private leaks into the repo.** That covers private notes, links or embeds that name them, and decoded real values.
- **The agent test passes.** An agent with no prior context, opened in the repo, can find the project's vault folder, read a vault-only note and update it correctly.
- **Published** in the VS Code Marketplace and the Obsidian community plugin store once the points above hold.

## Non-goals

- **Real-time co-editing or multi-user collaboration.** One person, one machine. This is why there is no CRDT or sync server.
- **Syncing across machines.** The repo's git remote and the vault's own sync (Obsidian Sync, Obsidian Git, a cloud drive) do that. Project Docs links two folders on the same machine.
- **Versioning or backup.** Git does that for the repo. Vault-only notes are versioned by the vault's own tools, such as Obsidian Git pushing to a private remote.
- **Sanitizing config files.** The config-example pattern (a committed `config.example`, a gitignored real config) already covers those.
- **A deterministic encoder.** Redacting real values into placeholders is done by hand or by an AI agent, which handles the judgment calls better than string matching. Decoding stays deterministic, following the standard.
- **In the first release:** Remote-SSH, Dev Containers, browser-based VS Code (vscode.dev, github.dev) and VS Code forks. These are possible later improvements.

## Core user journeys

Three rules apply across all journeys:

- **The repo is primary.** For a doc that exists on both sides, the repo's copy is the source of truth. That decides what happens when a project is first linked and both sides already have a file of the same name, and which version stays in place while a conflict waits to be resolved. The other version is always kept, never discarded.
- **Private notes are guarded twice.** They live in the project's private subfolder in the vault, which never syncs, *and* they carry frontmatter marking them private. A note marked private never syncs wherever it ends up, so moving it out of the subfolder by accident can't leak it.
- **Private note names never reach the repo either.** A synced doc may link to or embed a private note in the vault. While it does, that change is held back from the repo, and you're told why and which link causes it. It syncs once the link is gone. Stripping the link only from the repo copy was rejected: that copy would sync back and silently delete the link from your vault note. On the repo side, a link to a private note that is written directly in the repo is flagged in VS Code before it can be committed.

The journeys:

1. **Link a project.** Open the repo in VS Code and run "Link to Obsidian". Pick the vault (remembered after the first time) and accept the proposed folder, such as `Projects/<repo>/`. The first sync runs, and a link is recorded on both sides.
2. **Everyday editing.** Edit in either app and the other side catches up, even if it was closed at the time. Edits to different parts of a file merge. Edits that clash open VS Code's merge editor, with nothing lost in the meantime.
3. **Read decoded.** Open a coded doc in VS Code or Obsidian and switch to decoded to see the real values. A clear indicator shows which mode you're in. Switch back the same way.
4. **Keep a private note.** Create a note in the project's private subfolder in the vault, or move one there. The Obsidian plugin sets its private marker automatically, whether the note was created there, moved there, or arrived some other way. The note never reaches the repo, and moving it back out doesn't remove the marker. If the marker is removed some other way, by hand or by an agent rewriting the note, the note waits until you confirm before it reaches the repo.
5. **Follow the link.** From a project's vault folder, open the repo in VS Code. From the repo, a person or an agent finds the vault folder.
6. **An agent maintains docs.** An agent working in the repo reads the link and edits both repo docs and vault-only notes. Sync carries the repo-side edits into the vault.
7. **Change how a note syncs, with the mouse.** On either side, you can see a file's sync rule and change it without typing frontmatter. In Obsidian that's the note's right-click menu or an indicator on the note. In VS Code it's the Explorer's right-click menu or the status bar. Making a note private (Obsidian only, since private notes never reach the repo) takes effect immediately. Making a private note syncable again asks for confirmation first, because that is the one change that sends content into the repo.

### Files other than Markdown

Only Markdown syncs by default. Syncing other files (images, PDFs and other attachments) is off by default and can be switched on per project.

When it is on, attachments get the same double guard as notes, even though they can't carry frontmatter. The proposed mechanism is a **private-files list** kept in the project's vault folder, maintained by the Obsidian plugin and read by the sync engine:

- Every file that is created in, or moved into, the private subfolder is recorded by its path and its content hash.
- The plugin follows each recorded file through renames and moves, updating its path, and updates its hash when the file is edited in Obsidian.
- Sync never copies a file whose path or hash is on the list. Moving a private screenshot out of the folder, renaming it or duplicating it therefore can't leak it.
- Removing a file from the list is the same deliberate, confirmed action as making a private note syncable again.

The details belong to the requirements.

### Links between docs

Synced docs use **standard Markdown links** (`[text](other-doc.md)`), because both GitHub and Obsidian render them.

- Obsidian `[[wikilinks]]` and `![[embeds]]` written in the vault are converted to relative Markdown links as they sync to the repo, when their target is inside the linked folder. The converted text then syncs back, so both sides hold the same text.
- Links to vault notes **outside the project folder** are treated like links to private notes. They're held back from the repo by default, because a vault's note names are private unless you say otherwise. A per-project setting allows them; when allowed, they sync as written and are flagged, since they won't resolve in the repo.
- Links inside the project folder that have no Markdown equivalent are left as written and flagged. Examples: an embedded note, a block reference.
- A per-project setting keeps files exactly as written instead, for people who don't need the repo to render on GitHub.

Converting in both directions (wikilinks in the vault, Markdown links in the repo) was considered and rejected. The conversion can't be undone reliably: `[[Note]]` and `[Note](Note.md)` turn into each other ambiguously. Every sync could then rewrite files that nobody edited, fighting the merge logic that prevents data loss.

## Market and competitive context

Several Obsidian plugins sync a vault folder with something outside it. None covers what Project Docs is for:

| Tool | What it does | What's missing for this use |
|---|---|---|
| [Local Sync](https://forum.obsidian.md/t/new-plugin-local-sync-keep-your-ai-docs-and-obsidian-notes-in-sync/111599) | Pairs a local project folder with a vault folder and syncs both ways. Unlimited pairs, dry-run preview. | Resolves conflicts by picking a whole file (newer-wins by default) instead of merging. Lives only in Obsidian, so it syncs only while Obsidian is open. No frontmatter control, link conversion, redaction, or agent-readable link. |
| [Docs Sync](https://community.obsidian.md/plugins/docs-sync), [Easy Git](https://forum.obsidian.md/t/easy-git-plugin-sync-individual-folders-from-github-repos-to-and-from-your-vault/114501), Agentic Git Sync, Smart Vault Sync | Sync vault folders with a GitHub repo, mostly through the GitHub API. | Work against the remote, not the local working copy where the developer and their agents are editing. Mostly whole-vault or per-folder push/pull setups. |
| Synaptic Bridge | Syncs a vault with external folders, one-way or two-way. | General-purpose. Nothing specific to repos, PRIVATE.md or agents. |
| VaultLink | Self-hosted sync server that merges Markdown edits from Obsidian, Vim and VS Code. | Needs a server, and has no repo-to-vault mapping or redaction. |

What sets Project Docs apart:
- a three-way merge that never silently overwrites;
- PRIVATE.md decoding on both sides;
- private notes guarded twice;
- a link that agents can read;
- being driven from VS Code, where the repo lives.

This was a quick survey on 2026-10-22, based on project pages, not hands-on testing.

## Constraints and context

- **Publishing in both stores.** The extension goes to the VS Code Marketplace (and Open VSX later). The plugin goes to the Obsidian community store, which reads the plugin's `manifest.json` from the root of its GitHub repo. So the product spans separate repos: [vscode-project-docs](https://github.com/coreyx/vscode-project-docs) (the extension, and the home of this document) and [obsidian-project-docs](https://github.com/coreyx/obsidian-project-docs) (the plugin). Logic both need, such as the PRIVATE.md parser, is shared as a package rather than copied.
- **Part of SpecDevShip.** Project Docs belongs to the SpecDevShip project, and its npm packages are published under the `@specdevship` scope.
- **Follows an external standard.** PRIVATE.md behaviour follows the [PRIVATE.md standard](https://github.com/coreyx/private-md-standard), which is maintained separately and shared with other repos. Project Docs implements it and does not redefine it. Agents encode (redact) and decode with an agent skill that ships with the standard, so this works in Claude Code, Obsidian's AI plugins or any other agent, without Project Docs having to own it.
- **Platforms.** Desktop VS Code and desktop Obsidian, on Windows, macOS and Linux, plus WSL. Obsidian mobile isn't a target, since the repo isn't on the phone.
- **Release quality before publishing.** Nothing is published until the release bar under Goals is met.

## Open questions for later

- **Heading anchors.** GitHub links to a heading as `#heading-text`, while Obsidian matches the heading text itself. Can one link form work in both, or must anchors be converted?
- **Repo links outside the docs folder.** A link from a doc to `../src/app.ts` is broken in the vault. Could the Obsidian plugin open it in VS Code through the project link?
- **The private subfolder's name**, and whether it can be configured.
- **Private attachments changed outside Obsidian.** A recorded attachment that is both moved out of the private folder and edited by another app while Obsidian is closed matches neither its recorded path nor its hash. Should the sync engine hold back any new non-Markdown file in the project folder until the plugin has seen it?
- **Adoption measures**, if any are wanted after publishing.
