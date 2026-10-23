# Project Docs

Keep a repo's docs folder and a folder in your Obsidian vault in sync, on the same machine. Write docs in whichever app suits the moment; the other one has the change within a couple of seconds. Private notes stay in the vault, and docs that use [PRIVATE.md](https://github.com/coreyx/private-md-standard) placeholders can be read with their real values in both apps.

Project Docs never silently overwrites an edit. When the same doc is changed differently in both places, you get a merge editor, not a lost paragraph.

Project Docs is part of SpecDevShip. It has a companion Obsidian plugin.

## Getting started

1. Open the repo's folder in VS Code.
2. Run **Project Docs: Link to Obsidian** from the Command Palette, and answer three questions:
   - the docs folder in the repo (`docs` by default);
   - the vault, picked from the vaults Obsidian knows about;
   - the folder in the vault (`Projects/<repo name>` by default).
3. That's it. The first sync copies whatever each side has that the other doesn't. Where both sides have the same file with different content, the repo's version wins and the vault's version is kept as a conflict for you to merge.

The **Get Started with Project Docs** walkthrough on VS Code's Welcome page covers the same ground, one screen at a time.

Project Docs runs on Windows, macOS and Linux, and in WSL with the vault on the Windows side. Remote-SSH, Dev Containers and VS Code for the web aren't supported yet.

## How syncing works

- Edits flow both ways as you save. Renames and moves are followed, not turned into a delete and a copy.
- A file deleted on one side goes to the trash on the other: the operating system's trash for the repo, Obsidian's `.trash` folder for the vault.
- Edits to different parts of the same doc are merged automatically. Overlapping edits become a **conflict**: both versions are kept, the file stops syncing, and **Resolve Conflict** opens VS Code's three-way merge editor.
- A pass that would delete or overwrite many files at once (more than a quarter of the linked files, or more than 20) waits for you to say **Proceed**, with a summary of what it would do.
- Obsidian `[[wikilinks]]` written in the vault become standard Markdown links in both copies, so the docs read correctly on GitHub. Set `keepLinksAsWritten` to leave them alone.
- Only Markdown syncs by default. Set `syncAttachments` to sync images and other files too.
- Line endings are kept per side: a file that is CRLF in the repo and LF in the vault stays that way. A new file takes the line endings most of that side's docs already use, or LF, whatever your operating system, so a Windows checkout of an LF repo never gets CRLF files.
- Sync pauses with **Project Docs: Pause Sync** and catches up with **Resume Sync**.

The status bar shows **Up to date**, **Syncing**, **Paused** or **N need attention**. Click it to open the **Project Docs** view in the Explorer, which lists every conflict, held-back change, skipped file and invalid rule, each with the action that resolves it. **Project Docs: Show Log** opens the log, which never contains a real value from PRIVATE.md.

## Sync rules

A doc syncs both ways unless its frontmatter says otherwise:

```yaml
---
project-docs: repo-to-vault
---
```

| Rule            | What happens                                                                |
| --------------- | --------------------------------------------------------------------------- |
| `sync`          | Edits in either app are copied to the other. The default.                   |
| `repo-to-vault` | The repo's copy wins. Edits made in Obsidian are reported, not copied back. |
| `repo-only`     | Never copied to the vault. An existing vault copy is offered for the trash. |
| `private`       | Set in Obsidian: the note never reaches the repo.                           |

You don't need to type it. Right-click a doc in the Explorer and choose **Project Docs Sync Rule**, or click the rule shown in the status bar while the doc is open. Either way, only that one line of the file changes.

A rule Project Docs can't read stops that file syncing, and the Project Docs view says why.

## What never reaches the repo

Project Docs is built so that a public repo never reveals your vault:

- **Private notes.** Anything in the project folder's `private` subfolder, and any note marked `project-docs: private`, stays in the vault. A note in the private folder with no marker still stays there, so moving a note out of it by accident doesn't publish it.
- **Their names.** A synced note that links to a private note is held back, because the link would put the private note's name in the repo. So is a link to a note outside the project folder, unless `allowLinksOutsideProjectFolder` is on.
- **Real values.** An edit made in Obsidian that contains a real value from PRIVATE.md is held back, and you're offered to replace it with its placeholder.
- **The link note**, which records your local paths, never syncs, whatever its frontmatter says.
- **Private files.** Attachments listed in the vault's `.project-docs/private-files.json` never sync.

A held-back change stays in the vault and syncs as soon as its cause is removed. Docs already in the repo that contain a real value or link to a private note get an entry in the **Problems** panel, so you see them before you commit.

A note that stops being private without your say-so waits for you: its marker removed in a text editor or by an agent, or an unmarked file moved out of the private folder with a file manager. The Project Docs view lists it, and **Sync to Repo…** asks before copying it into the repo. Making a note syncable from the Obsidian plugin's menu asks there instead, once. The command line reports such a note but can't release it.

Turning a synced note private in Obsidian stops syncing it but leaves the repo's copy where it is. Project Docs offers to move that copy to the trash; it never deletes it on its own.

## PRIVATE.md

[PRIVATE.md](https://github.com/coreyx/private-md-standard) is an open standard for docs that need real values, such as hostnames and internal addresses, but must be publishable. Committed docs use placeholders, and a gitignored `PRIVATE.md` at the repo root maps each placeholder to its real value:

```markdown
## Placeholders

| Placeholder in the repo | Real value    | What it is           |
| ----------------------- | ------------- | -------------------- |
| `myhost`                | `DESK-FAKE01` | Workstation hostname |
```

- **Project Docs: Set up PRIVATE.md** creates `PRIVATE.md` with an empty table and a committed `PRIVATE.example.md`, and adds `PRIVATE.md` and `*.private.md` to `.gitignore`.
- When a linked repo has a PRIVATE.md, Project Docs offers once to install the standard's **commit hooks**, which block any commit containing a real value. They need Python 3. **Project Docs: Install PRIVATE.md Commit Hooks** runs the same thing later.
- **Decoded view.** Click the eye in a doc's title bar to read it with real values. The view opens with a tab ending "(Decoded: real values shown)" and the status bar says so too. It follows your edits, and it can't be edited or saved, so real values never end up in a file. Click the closed eye to go back; the status bar then says **Coded**. **Open Decoded Preview** shows the same text in VS Code's Markdown preview.
- If PRIVATE.md is missing or invalid, nothing is decoded and you're told why. Since PRIVATE.md is gitignored, git can't restore it: keep a copy somewhere safe.

## Opening the project in Obsidian

**Project Docs: Open in Obsidian** opens the project's folder note in your vault. That note, `Projects/<repo>/<repo>.md` by default, is the **link note**: it holds the repo's path and a link that opens the repo in VS Code, so you can go back and forth.

By default the command uses Obsidian's own `obsidian://open` link to the note.

If you use the [Advanced URI](https://github.com/Vinzent03/obsidian-advanced-uri) plugin, Project Docs offers **deep links** (the `advancedUriDeepLinks` setting). The link finds the folder note even after the folder is renamed or moved. Turning them on makes two changes, which Project Docs lists and makes only once you confirm, both or neither:

- the folder note gets a `uid: <project id>` property;
- `.project-docs.json` gets an `obsidian://adv-uri?uid=<project id>` link. It names no vault, so it's safe to commit, and everyone who clones the repo gets it.

If you switch the setting on by editing `.project-docs.json`, you get the same list, and cancelling turns the setting back off. On a machine whose folder note has no `uid` yet, for example after a teammate turned deep links on, Project Docs asks once before adding it; until then, **Open in Obsidian** opens the note by its path. Turning deep links off removes the link from `.project-docs.json` and leaves the `uid` in the note.

**`uid: <project id>` belongs in the project folder's folder note.** That anchors the link to the project folder rather than to whichever note happens to hold it, so it keeps working however the folder's contents change. If you add the `uid` yourself, put it there.

## Settings

Settings live in `.project-docs.json`, so everyone who clones the repo shares them. VS Code validates the file and describes each setting on hover.

| Setting                          | Default                    | What it does                                                     |
| -------------------------------- | -------------------------- | ---------------------------------------------------------------- |
| `privateSubfolder`               | `private`                  | The vault subfolder whose notes never sync.                      |
| `folderNotePattern`              | `{folder}/{folderName}.md` | Where the link note goes.                                        |
| `syncAttachments`                | `false`                    | Also sync files other than Markdown.                             |
| `keepLinksAsWritten`             | `false`                    | Leave wikilinks as written instead of converting them.           |
| `allowLinksOutsideProjectFolder` | `false`                    | Let synced notes link to vault notes outside the project folder. |
| `advancedUriDeepLinks`           | `false`                    | Open the project through Advanced URI deep links (see above).    |

## For agents and scripts: the link files

A linked repo has two files at its root. Both are JSON, carry a `format` version, and start with a plain-language `description`, so an agent seeing them for the first time can tell what they are.

**`.project-docs.json`** is committed. It holds no absolute path, user name or vault name:

```json
{
  "format": 1,
  "description": "Project Docs link: this repo's docs folder is kept in sync with a folder in an Obsidian vault. The vault's location on this machine is in .project-docs.local.json.",
  "projectId": "pd_3f2a…",
  "docsFolder": "docs",
  "vaultFolder": "Projects/my-repo",
  "settings": { "privateSubfolder": "private" }
}
```

**`.project-docs.local.json`** is gitignored. It holds this machine's paths:

```json
{
  "format": 1,
  "description": "Project Docs: this machine's location of the linked vault folder. Not committed.",
  "projectId": "pd_3f2a…",
  "vaultRoot": "/home/me/Notes",
  "vaultFolderPath": "/home/me/Notes/Projects/my-repo",
  "linkNotePath": "/home/me/Notes/Projects/my-repo/my-repo.md"
}
```

So to find a project's vault notes, read `vaultFolderPath` from `.project-docs.local.json`, or run `project-docs where`. Notes in its `private` subfolder are the project's vault-only notes; edit them in place. The machine-local file is the source of truth for the vault's location; deep links are a convenience for people.

## The command line

[`@specdevship/project-docs-cli`](https://www.npmjs.com/package/@specdevship/project-docs-cli) runs the same sync engine from a terminal, for agents and for when VS Code is closed:

```sh
project-docs status   # what a sync would do, and any problems
project-docs sync     # run one sync pass
project-docs where    # print the linked vault folder
```

It applies the same rules and safeguards as the extension, and won't run while VS Code is syncing the same link.

## License

MIT
