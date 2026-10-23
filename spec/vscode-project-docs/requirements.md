---
status: approved
---

# Requirements Specification: Project Docs

## 1. Project Summary

This spec covers the first release of Project Docs, the whole product:

- **The VS Code extension**, which hosts the sync engine.
- **The shared core package**, which holds the sync engine, frontmatter rules, link formats, the PRIVATE.md decoder and the private-files list.
- **The Obsidian plugin**, which is built in its own repository against the contracts defined here.

Each requirement names the component that delivers it. Requirements for the plugin are stated here so that both sides are specified together. The plugin's own spec links back to them rather than restating them.

The first release keeps one docs folder per repo in sync with one folder in one vault, on one machine, without ever silently overwriting an edit. It keeps private material out of the repo, decodes PRIVATE.md documents on both sides, and leaves a link that people and agents can follow in both directions.

**Related documents**
- [Product](product.md)
- [PRIVATE.md standard](https://github.com/coreyx/private-md-standard)

## 2. Requirements (EARS Format)

Requirements use the Easy Approach to Requirements Syntax (EARS):
- **Ubiquitous**: The system shall <response>.
- **Event-Driven**: When <trigger>, the system shall <response>.
- **State-Driven**: While <precondition>, the system shall <response>.
- **Unwanted Behavior**: If <unwanted condition>, then the system shall <response>.
- **Optional Feature**: Where <feature is enabled>, the system shall <response>.

Terms used throughout:

| Term | Meaning |
|---|---|
| **Link** | The pairing of one repo docs folder with one vault folder. |
| **Repo side** | The linked docs folder inside the repo. |
| **Vault side** | The linked folder inside the vault, and everything under it. |
| **Private subfolder** | The subfolder of the vault side that never syncs (`private/` unless configured otherwise). |
| **Base** | The last version of a file that both sides agreed on, kept by the sync engine outside both folders. |
| **Held back** | A change that is kept from reaching the repo, with the reason shown to the user, until the cause is removed. |
| **Sync rule** | A file's setting for whether and in which direction it syncs. |

### REQ-1: Link a project

**User Story**: As a developer, I want to link a repo's docs folder to a folder in my vault in under a minute, so that I never copy docs by hand again.

**Component**: extension

- **1.0.1 (Event-Driven)**: When the user runs "Project Docs: Link to Obsidian" in a repo with no link, the system shall:
  1. ask for the docs folder (default `docs/`, if it exists);
  2. ask for the vault, offering the vaults Obsidian knows about and remembering the last one chosen;
  3. ask for the vault folder (default `Projects/<repo folder name>/`);
  4. create the link.
- **1.0.2 (Ubiquitous)**: The system shall support exactly one link per repo in the first release.
- **1.0.3 (Event-Driven)**: When a link is created and both sides already contain files, the system shall run a first sync in which the repo is primary. Wherever both sides hold different content for the same path, the system shall keep the repo's version in place and preserve the vault's version as a conflict for the user to resolve (REQ-5).
- **1.0.4 (Unwanted Behavior)**: If the chosen vault folder lies inside the repo, or the docs folder lies inside the vault, then the system shall refuse to create the link and explain why, so that sync can never feed itself.
- **1.0.5 (Event-Driven)**: When the user runs "Project Docs: Unlink", the system shall stop syncing and remove the link records from both sides, leaving every file where it is.

#### Acceptance Criteria
- **1.1**: Starting from a repo with a `docs/` folder and a vault Obsidian knows about, linking takes no more than four prompts, each with a usable default, and the first sync completes.
- **1.2**: The second link in another repo offers the previously chosen vault as the default.
- **1.3**: When the same path exists on both sides with different content, the repo's version is in both places after the first sync, the vault's version is preserved, and a conflict is reported for it.
- **1.4**: Choosing a vault folder inside the repo, or a docs folder inside the vault, is refused with an explanation, and nothing is written.
- **1.5**: After unlinking, editing a file on either side changes nothing on the other side, and no file has been deleted or moved.

### REQ-2: The link record and agent discovery

**User Story**: As a person or a coding agent working in a repo, I want to find the project's vault folder from a plain file, and get back to the repo from the vault, so that documentation outside the repo can be found and maintained.

**Component**: core (formats), extension (writes them), plugin (reads the vault side)

- **2.0.1 (Ubiquitous)**: The system shall record each link on the repo side in two files:
  - a **committed** link file that contains no absolute paths, user names or vault names: only the docs folder, the vault-relative folder, and a stable project id;
  - a **gitignored, machine-local** link file that contains the absolute vault folder path.
- **2.0.2 (Ubiquitous)**: The system shall record each link on the vault side in a **link note**. It contains the repo's absolute path, the project id, and a link that opens the repo in VS Code.
  - The link note is the vault folder's **folder note**, so the link is anchored to the project folder itself. By default that's a note named after the folder, inside it (`Projects/<repo>/<repo>.md`). The name pattern can be changed to match the user's folder-note convention.
  - If a folder note already exists, the system shall add the link properties to it rather than create a second note.
- **2.0.3 (Ubiquitous)**: The system shall never sync the link note to the repo, whatever its frontmatter says, because it contains a local absolute path.
- **2.0.4 (Ubiquitous)**: The system shall write every path in a link record in the form the side reading it can open. Under WSL, a Windows-side record of a WSL repo uses the `\\wsl.localhost\<distro>\...` form, and a WSL-side record of a Windows vault uses the `/mnt/<drive>/...` form.
- **2.0.5 (Ubiquitous)**: The link files shall be JSON, carry a format version, and include a one-sentence plain-language description of what they are, so that an agent with no prior context can interpret them.
- **2.0.6 (Event-Driven)**: When the system creates a link, it shall add the machine-local link file to the repo's `.gitignore` if it isn't already ignored.
- **2.0.7 (Unwanted Behavior)**: If the committed link file is present but the machine-local one is missing (a fresh clone, or another machine), then the system shall offer to re-link to a vault folder, defaulting to the recorded vault-relative folder, instead of creating a new project.
- **2.0.8 (Optional Feature)**: Where the "Advanced URI deep links" setting is on (off by default, and offered when the Advanced URI plugin is detected in the vault), the system shall:
  - set the link note's `uid` frontmatter property to the project id;
  - add to the committed link file a deep link of the form `obsidian://adv-uri?uid=<project id>`, with no `vault` parameter, so that it opens the link note in the last-used vault without naming the vault;
  - use that deep link for the extension's "Open in Obsidian" command.
- **2.0.9 (Optional Feature)**: Where the setting is off, the "Open in Obsidian" command shall use Obsidian's built-in `obsidian://open` link, built from the machine-local link file and never written to a committed file.
- **2.0.10 (Ubiquitous)**: Deep links shall be a convenience for people only. The machine-local link file remains the source of the vault path for the sync engine, the command-line tool and agents.
- **2.0.11 (Ubiquitous)**: The user documentation (the extension's README, the setting's description, and the plugin's README) shall explain that `uid: <project id>` belongs in the project folder's **folder note**. That anchors the deep link to the project folder rather than to an arbitrary note, so it keeps working however the folder's contents change. Anyone adding the `uid` by hand should put it there.
- **2.0.12 (Event-Driven)**: When the user turns the deep-link setting on, the system shall first list the changes it will make (the deep link added to the committed link file, which everyone who clones the repo gets, and the `uid` added to the vault's folder note), and shall make both or neither, as the user confirms or cancels.
- **2.0.13 (Unwanted Behavior)**: If the committed setting is on but this machine's folder note has no `uid` (for example, a teammate turned the setting on), then the system shall ask before adding the `uid`, and until it is added, "Open in Obsidian" shall use the `obsidian://open` link of 2.0.9.

#### Acceptance Criteria
- **2.1**: After linking, the committed link file contains no absolute path, no user name and no vault name. A test scans it for the drive letter, the home folder and the vault's name, and finds none.
- **2.2**: After linking, the machine-local link file is ignored by git (`git check-ignore` succeeds on it).
- **2.3**: An agent given only the repo, and the instruction to find the project's vault notes, reads the link files, opens the vault folder, reads a vault-only note and updates it correctly (the agent test from product.md).
- **2.4**: Activating the "open repo" link in the link note opens the repo in VS Code on Windows, macOS, Linux, and for a WSL repo from Windows.
- **2.5**: Deleting the machine-local link file and reopening the repo produces a re-link prompt that defaults to the recorded vault folder, and keeps the same project id.
- **2.6**: With the deep-link setting on and Advanced URI installed:
  - the committed link file contains `obsidian://adv-uri?uid=<project id>` and still no vault name;
  - opening that link opens the link note, including after the vault folder has been renamed or moved;
  - "Open in Obsidian" in VS Code does the same.
- **2.7**: With the setting off, no `uid` property is written, the committed link file contains no deep link, and "Open in Obsidian" still opens the vault folder.
- **2.8**: Linking creates the link note as the folder note (`Projects/<repo>/<repo>.md` by default). When a folder note already exists, its content is kept and only the link properties are added.
- **2.9**: The link note never appears in the repo, even if its sync rule is set to `sync`.
- **2.10**: The extension's README, the deep-link setting's description and the plugin's README each state that `uid: <project id>` belongs in the project folder's folder note.
- **2.11**: Accepting the deep-link offer shows both changes before anything is written. Cancelling leaves `.project-docs.json` and the folder note byte-identical; confirming makes both changes.
- **2.12**: Pulling a `.project-docs.json` with the setting on into a clone whose folder note has no `uid` writes nothing until the user agrees, and "Open in Obsidian" meanwhile opens the folder note through `obsidian://open`.

### REQ-3: Two-way sync of Markdown

**User Story**: As a developer, I want edits in either app to appear in the other, so that both homes stay current.

**Component**: core, extension

- **3.0.1 (State-Driven)**: While a link exists and VS Code has the repo open, the system shall propagate every created, changed, renamed or deleted Markdown file whose sync rule allows it from either side to the other.
- **3.0.2 (Ubiquitous)**: The system shall propagate a change within 2 seconds of the file being saved, where the filesystem supports change notification, and within 10 seconds where it must poll (REQ-4).
- **3.0.3 (Ubiquitous)**: The system shall treat files whose extension is `.md` as Markdown.
- **3.0.4 (Ubiquitous)**: The system shall write each file on the receiving side atomically, so that an app reading it never sees a partly written file.
- **3.0.5 (Ubiquitous)**: The system shall preserve each side's line-ending style for a file. Content is compared without regard to line endings, and a file is written in the line endings it already has on that side. A new file is written in the line endings most of that side's existing Markdown files use, or LF when the side has none, whatever the operating system.
- **3.0.6 (Ubiquitous)**: The system shall never sync `PRIVATE.md`, `PRIVATE.example.md` or `*.private.md` files, in either direction, whatever their location or sync rule.

#### Acceptance Criteria
- **3.1**: Saving a change to a synced note in Obsidian updates the repo file within 2 seconds on a local disk, and saving in VS Code updates the vault file within 2 seconds.
- **3.2**: A file that is CRLF in the repo and LF in the vault keeps those line endings after edits on both sides sync.
- **3.3**: A reader polling a file while it is being synced never observes a truncated or partial file (verified by a stress test that compares every read with a complete version).
- **3.4**: `PRIVATE.md`, `PRIVATE.example.md` and `notes.private.md` placed in the docs folder never appear in the vault, and the same names placed in the vault never appear in the repo.
- **3.5**: On Windows, a new note created in Obsidian reaches a repo whose docs are LF as an LF file, and reaches a repo whose docs are mostly CRLF as a CRLF file. A new repo doc reaches the vault as an LF file on every operating system.

### REQ-4: Detecting changes, including while closed

**User Story**: As a developer, I want changes made while one app was closed to be picked up later, so that nothing depends on both apps being open.

**Component**: core, extension

- **4.0.1 (Event-Driven)**: When the repo is opened in VS Code with a link, the system shall compare both sides with their bases and reconcile every difference before reporting itself up to date.
- **4.0.2 (Ubiquitous)**: The system shall use native file watching where it is reliable, and fall back to polling where it isn't, including a WSL repo watching a vault on `/mnt/<drive>` and network drives.
- **4.0.3 (Ubiquitous)**: The system shall run a full rescan periodically (default every 10 minutes) as a safety net against missed watch events.
- **4.0.4 (State-Driven)**: While VS Code is closed, the system shall not sync. Changes on either side are picked up when the repo is next opened (or by the command line, REQ-18).

#### Acceptance Criteria
- **4.1**: Edits made on both sides while VS Code is closed, to different files, are all present on both sides after reopening the repo, with no conflicts reported.
- **4.2**: For a WSL repo linked to a vault on `C:`, a change in the vault reaches the repo within 10 seconds.
- **4.3**: A change made while the watcher is deliberately disabled in a test is reconciled by the next periodic rescan.

### REQ-5: Merging and conflicts

**User Story**: As a developer, I want edits on both sides to merge, and real clashes to be shown to me, so that no edit is ever lost.

**Component**: core, extension

- **5.0.1 (Event-Driven)**: When the same file has changed on both sides since its base, the system shall attempt a three-way line merge against the base.
- **5.0.2 (Event-Driven)**: When the merge succeeds with no overlapping changes, the system shall write the merged result to both sides and make it the new base.
- **5.0.3 (Unwanted Behavior)**: If the changes overlap, then the system shall:
  - keep the repo's version in place on both sides;
  - preserve the vault's version in the engine's conflict store;
  - report the conflict;
  - offer to open VS Code's merge editor with the base, the repo version and the vault version.
- **5.0.4 (Ubiquitous)**: The system shall never discard a version of a file without the user's explicit action. Every version it replaces is either merged in or kept as a conflict.
- **5.0.5 (State-Driven)**: While a file has an unresolved conflict, the system shall continue syncing other files, and shall not sync further changes to that file until the conflict is resolved.
- **5.0.6 (Event-Driven)**: When the user resolves a conflict in the merge editor, the system shall write the result to both sides and make it the new base.

#### Acceptance Criteria
- **5.1**: Editing paragraph 1 in VS Code and paragraph 5 in Obsidian before the next sync gives both edits on both sides, with no conflict.
- **5.2**: Editing the same line differently on both sides reports a conflict. The repo's text is on both sides, and the vault's text can be recovered from the conflict, through the merge editor, after a restart.
- **5.3**: Resolving a conflict in the merge editor puts the resolved text on both sides, and later edits sync normally.
- **5.4**: A randomized test of interleaved edits, renames, deletes and restarts on both sides never loses a version. Every version written by either side is present on disk, in the conflict store, or in the trash (REQ-6).

### REQ-6: Renames, moves and deletes

**User Story**: As a developer, I want renames and deletes to carry across safely, so that the two sides keep the same structure without risking data.

**Component**: core, extension

- **6.0.1 (Event-Driven)**: When a synced file is renamed or moved within its side, the system shall rename or move it on the other side rather than deleting and recreating it, so that its history of edits and merges is kept.
- **6.0.2 (Ubiquitous)**: The system shall treat a rename that only changes letter case as a rename on every platform, including case-insensitive filesystems.
- **6.0.3 (Event-Driven)**: When a synced file is deleted on one side, the system shall delete it on the other side by moving it to that side's trash: Obsidian's trash for the vault side, the operating system's trash for the repo side.
- **6.0.4 (Unwanted Behavior)**: If a file is deleted on one side and changed on the other since its base, then the system shall keep the changed version on both sides and report that a delete was overridden.

#### Acceptance Criteria
- **6.1**: Renaming `a.md` to `b.md` in Obsidian renames the repo file. Git shows a rename, not a delete and an add, when the content is unchanged.
- **6.2**: Renaming `Readme.md` to `README.md` on Windows and macOS carries the new case to the other side.
- **6.3**: Deleting a synced file in VS Code moves the vault copy to Obsidian's trash, where it can be restored.
- **6.4**: Deleting a file in the vault while it was edited in the repo leaves the edited version on both sides, with a notice.

### REQ-7: Bulk-change guard

**User Story**: As a developer, I want to be asked before sync makes a large number of changes at once, so that a branch switch or a mistake can't sweep through my vault silently.

**Component**: core, extension

- **7.0.1 (Unwanted Behavior)**: If a single sync pass would delete or overwrite more files than a threshold (default: more than 20 files, or more than 25% of the linked files, whichever is smaller), then the system shall pause that pass, show a summary of what would change, and wait for the user to proceed or cancel.
- **7.0.2 (Event-Driven)**: When the user cancels, the system shall make no changes and keep the pass pending until the user next runs sync or proceeds.

#### Acceptance Criteria
- **7.1**: Switching to a git branch on which 30 docs were deleted shows the summary, and no vault file is touched until the user chooses to proceed.
- **7.2**: Cancelling leaves both sides unchanged, and the pending pass can be proceeded with later from the status bar.

### REQ-8: Per-file sync rules in frontmatter

**User Story**: As a developer, I want optional frontmatter to control whether and how each file syncs, so that the defaults never get in the way.

**Component**: core

- **8.0.1 (Ubiquitous)**: The system shall read a file's sync rule from a single flat frontmatter property, `project-docs`. Flat, so that Obsidian's Properties panel can edit it. Its values are:

  | Value | Behavior |
  |---|---|
  | `sync` | Two-way. The default when the property is absent. |
  | `repo-to-vault` | The repo is authoritative. Vault edits are not sent to the repo. They are reported, and kept as a conflict when the repo next changes. |
  | `repo-only` | Never copied to the vault. A vault copy that already exists is moved to the trash after confirmation. |
  | `private` | Vault-only. Never copied to the repo (REQ-10). |

- **8.0.2 (Unwanted Behavior)**: If the property has any other value, then the system shall not sync the file and shall report the invalid value.
- **8.0.3 (Ubiquitous)**: The system shall apply a rule from the file's current content on whichever side it was last changed, before deciding whether to sync that change.

#### Acceptance Criteria
- **8.1**: A file with no `project-docs` property syncs both ways.
- **8.2**: A file marked `repo-only` in the repo never appears in the vault.
- **8.3**: Editing a `repo-to-vault` file in Obsidian leaves the repo unchanged and reports the vault edit. The next repo change keeps the vault edit as a conflict rather than overwriting it.
- **8.4**: `project-docs: typo` stops the file syncing and shows a problem naming the file and the invalid value.

### REQ-9: Changing sync rules with the mouse

**User Story**: As a developer, I want to see and change a file's sync rule without typing frontmatter, in either app.

**Component**: extension, plugin

- **9.0.1 (Ubiquitous)**: The system shall show the current file's sync rule:
  - in VS Code, in the status bar;
  - in Obsidian, in the status bar and as an indicator on the note.
- **9.0.2 (Event-Driven)**: When the user right-clicks a file, the system shall offer the applicable sync rules in the context menu, and set the frontmatter property when one is chosen:
  - in VS Code's Explorer: `sync`, `repo-to-vault`, `repo-only`;
  - in Obsidian's file menu: `sync`, `repo-to-vault`, `repo-only`, `private`.
- **9.0.3 (Event-Driven)**: When the user clicks the status bar item, the system shall offer the same choices.
- **9.0.4 (Event-Driven)**: When the user changes a note from `private` to any syncable rule, the system shall ask for confirmation, naming the note and stating that it will be copied into the repo, before changing it.

#### Acceptance Criteria
- **9.1**: Every rule change in both apps can be completed with the mouse alone, in no more than three clicks from the file.
- **9.2**: Choosing a rule writes exactly the `project-docs` property and leaves the rest of the file byte-identical.
- **9.3**: Changing a note from `private` to `sync` shows a confirmation, and cancelling it leaves the note private.

### REQ-10: Private notes

**User Story**: As a developer, I want project-private notes to live beside my synced docs without any risk of reaching the repo.

**Component**: plugin (marking), core (enforcement)

- **10.0.1 (Ubiquitous)**: The system shall never copy to the repo any file inside the private subfolder, whatever its frontmatter says.
- **10.0.2 (Ubiquitous)**: The system shall never copy to the repo any file whose `project-docs` property is `private`, wherever it is in the vault.
- **10.0.3 (Event-Driven)**: When a Markdown file is created in, moved into, or copied into the private subfolder, the plugin shall set its `project-docs` property to `private`, if it isn't already.
- **10.0.4 (Event-Driven)**: When Obsidian starts, the plugin shall mark any Markdown file in the private subfolder that arrived while Obsidian was closed and lacks the marker.
- **10.0.5 (Event-Driven)**: When a private note is moved out of the private subfolder, the system shall keep its `private` marker.
- **10.0.6 (Unwanted Behavior)**: If the sync engine finds a file in the private subfolder without the marker (for example, while Obsidian is closed), then it shall still not sync it, per 10.0.1.
- **10.0.7 (Unwanted Behavior)**: If a vault file the engine last saw as private (by its folder, its marker or the private-files list) becomes syncable without the confirmation of 9.0.4, for example because its marker was removed by hand or it was moved out of the private subfolder with a file manager, then the system shall hold it back, report that it was private, and copy it into the repo only after the user confirms in VS Code or Obsidian, naming the note and stating that it will be copied into the repo.
- **10.0.8 (Ubiquitous)**: The command-line tool shall report a note held back under 10.0.7, and shall offer no way to confirm it, so that an agent can't publish a private note by mistake.

#### Acceptance Criteria
- **10.1**: A note created in `private/` has `project-docs: private` within 2 seconds and never appears in the repo.
- **10.2**: Moving a private note from `private/` to the vault folder's root keeps it out of the repo.
- **10.3**: A file copied into `private/` with a file manager while Obsidian is closed gets its marker on Obsidian's next start, and never reaches the repo in the meantime.
- **10.4**: Deleting the `project-docs: private` line from a private note in a text editor holds the note back: it doesn't reach the repo, VS Code's Project Docs view offers to sync it, and confirming copies it into the repo, while cancelling leaves it held back.
- **10.5**: Moving an unmarked file out of `private/` with a file manager holds it back in the same way, and `project-docs sync` reports it without copying it.
- **10.6**: Un-privating a note from the Obsidian plugin's menu (9.3) asks once, and the note then syncs without a second confirmation in VS Code.

### REQ-11: Files other than Markdown

**User Story**: As a developer, I want attachments left alone unless I choose to sync them, and protected when I do.

**Component**: core, plugin

- **11.0.1 (Ubiquitous)**: The system shall sync only Markdown files by default.
- **11.0.2 (Optional Feature)**: Where attachment sync is switched on for a link, the system shall sync other files in both directions, copying them whole (no merging). When both sides change the same file, it shall keep the repo's version in place and preserve the vault's version as a conflict.
- **11.0.3 (Optional Feature)**: Where attachment sync is switched on, the plugin shall keep a **private-files list** in the vault folder, recording the path and content hash of every file created in or moved into the private subfolder. It shall follow each recorded file through renames and moves, and update its hash when it changes in Obsidian.
- **11.0.4 (Optional Feature)**: Where attachment sync is switched on, the system shall never copy to the repo a file whose path or content hash is on the private-files list.
- **11.0.5 (Event-Driven)**: When the user removes a file from the private-files list, the system shall ask for confirmation first, as in 9.0.4.

#### Acceptance Criteria
- **11.1**: With default settings, a PNG added to the repo docs folder doesn't appear in the vault, and one added to the vault doesn't appear in the repo.
- **11.2**: With attachment sync on, a PNG added on either side appears on the other.
- **11.3**: With attachment sync on, a PNG placed in `private/`, then moved, renamed and duplicated outside it, never appears in the repo.

### REQ-12: Links between docs

**User Story**: As a developer, I want links in synced docs to work in both GitHub and Obsidian.

**Component**: core

- **12.0.1 (Event-Driven)**: When a change syncs from the vault to the repo, the system shall convert `[[wikilinks]]` and `![[embeds]]` whose targets are synced files inside the vault folder to relative Markdown links. It shall preserve the alias text and heading anchors, and then write the converted text back to the vault, so that both sides hold identical text.
- **12.0.2 (Ubiquitous)**: The system shall leave as written, and report, any link inside the vault folder that has no Markdown equivalent, such as a note embed or a block reference.
- **12.0.3 (Optional Feature)**: Where a link's "keep links as written" setting is on, the system shall skip conversion entirely.

#### Acceptance Criteria
- **12.1**: `[[Setup Guide|setup]]`, written in Obsidian and pointing to `Setup Guide.md` in the same folder, becomes `[setup](Setup%20Guide.md)` on both sides, and the link resolves in GitHub's renderer and in Obsidian.
- **12.2**: `![[diagram.png]]`, with the image synced, becomes `![diagram.png](diagram.png)`.
- **12.3**: A block reference `[[Note#^abc123]]` is left as written and reported.
- **12.4**: With "keep links as written" on, no file's text is changed by sync.

### REQ-13: Keeping private content out of the repo

**User Story**: As a developer, I want sync to hold back anything that would expose private material in the repo, so that a public repo never reveals my vault.

**Component**: core, extension

- **13.0.1 (Unwanted Behavior)**: If a vault change to a synced file contains a link or embed whose target is a private note or a private-listed file, then the system shall hold back that change and report the file and the offending link.
- **13.0.2 (Unwanted Behavior)**: If a vault change to a synced file contains a link or embed whose target is outside the vault folder, then the system shall hold back that change and report it, unless the link's "allow links outside the project folder" setting is on.
- **13.0.3 (Unwanted Behavior)**: If a vault change to a synced file contains a real value from the repo's PRIVATE.md, then the system shall hold back that change. It shall report the file and the placeholder, never the real value, and offer to replace the real value with its placeholder.
- **13.0.4 (Event-Driven)**: When the cause of a held-back change is removed, the system shall sync the change normally.
- **13.0.5 (Ubiquitous)**: The extension shall show a problem on any file in the repo docs folder that links to a private note, or contains a real value from PRIVATE.md, so that the user sees it before committing.

#### Acceptance Criteria
- **13.1**: Adding `[[private/server-notes]]` to a synced note in Obsidian leaves the repo file at its previous version and shows a held-back notice naming the link. Removing the link syncs the note.
- **13.2**: Adding a link to a vault note outside the project folder is held back by default, and syncs as written once the setting allows it.
- **13.3**: Typing a real hostname from PRIVATE.md into a synced note in Obsidian holds the change back. The notice shows the placeholder and not the hostname. Accepting the offer replaces the hostname with the placeholder and syncs.
- **13.4**: A repo doc containing a real value shows a problem in VS Code's Problems panel that names the placeholder.

### REQ-14: PRIVATE.md decoded views

**User Story**: As a developer, I want to read coded docs with their real values in either app, and always know which mode I'm in.

**Component**: core (decoder), extension, plugin

- **14.0.1 (Ubiquitous)**: The system shall decode exactly as the PRIVATE.md standard specifies, and its decoder shall pass every case in the standard's conformance suite.
- **14.0.2 (Event-Driven)**: When the user toggles "decoded" on a coded doc in a repo with a valid PRIVATE.md, the system shall show the decoded text:
  - in VS Code, as a read-only decoded editor or preview;
  - in Obsidian, as a read-only decoded view of the note, opened from the note's header in the same tab.
- **14.0.3 (Ubiquitous)**: The system shall never write decoded text to any file, and the decoded view shall be read-only.
- **14.0.4 (State-Driven)**: While a decoded view is shown, the system shall show a persistent indicator that reads "Decoded: real values shown", in the editor's tab or title and in the status bar. While the coded text is shown in a repo with PRIVATE.md, it shall show "Coded".
- **14.0.5 (Unwanted Behavior)**: If PRIVATE.md is missing, has no `## Placeholders` table, or lists a placeholder twice, then the system shall show the error and no decoded view, never a partly decoded one.
- **14.0.6 (Ubiquitous)**: The Obsidian plugin shall read PRIVATE.md from the repo through the link record, and shall not copy it into the vault.

#### Acceptance Criteria
- **14.1**: The core decoder passes all of the standard's conformance cases byte for byte.
- **14.2**: Toggling decoded in VS Code shows real values, with the indicator visible. Typing in the decoded view is impossible, and the coded file on disk is unchanged.
- **14.3**: Toggling decoded in Obsidian shows real values with the indicator, including in footnotes, properties and embedded notes, and no file in the vault or repo changes.
- **14.4**: Deleting PRIVATE.md and toggling decoded shows the "restore it from wherever you keep it" error and no real values.

### REQ-15: PRIVATE.md discoverability and setup

**User Story**: As a developer who has never heard of PRIVATE.md, I want to discover it and set it up easily, since it's on by default.

**Component**: extension, plugin

- **15.0.1 (Ubiquitous)**: The system shall enable PRIVATE.md support by default.
- **15.0.2 (Ubiquitous)**: The extension shall include a getting-started walkthrough that explains PRIVATE.md in one screen and links to the standard.
- **15.0.3 (Event-Driven)**: When the user runs "Project Docs: Set up PRIVATE.md" in a repo without one, the system shall create `PRIVATE.md` with an empty `## Placeholders` table and `PRIVATE.example.md`, and add `PRIVATE.md` and `*.private.md` to `.gitignore`.
- **15.0.4 (Event-Driven)**: When a repo with a PRIVATE.md is linked, the system shall offer once to install the standard's commit hooks, which the user can accept or dismiss permanently.
- **15.0.5 (Ubiquitous)**: The decoded/coded toggle shall be reachable from the editor title bar in VS Code, and from the note's header in Obsidian, without using a command.
- **15.0.6 (State-Driven)**: While a repo's PRIVATE.md has a well-formed `## Placeholders` table with no rows, as setup creates it, the system shall treat it as valid with nothing to protect: sync proceeds normally, and the decoded view shows the doc unchanged with a note that PRIVATE.md has no placeholders yet. This follows the version of the PRIVATE.md standard that allows an empty table.

#### Acceptance Criteria
- **15.1**: On a fresh install, the walkthrough appears in VS Code's Welcome page and covers linking and PRIVATE.md.
- **15.2**: "Set up PRIVATE.md" produces both files and the `.gitignore` entries, and `git status` shows `PRIVATE.example.md` but not `PRIVATE.md`.
- **15.3**: The toggle is visible on a coded doc in both apps without opening any menu.
- **15.4**: Straight after "Set up PRIVATE.md", a sync pass reports no PRIVATE.md problem, and toggling decoded on a doc shows it unchanged with the "no placeholders yet" note. Removing the table's heading instead shows the error of 14.0.5.

### REQ-16: The same behavior on every platform

**User Story**: As a developer, I want Project Docs to behave the same on Windows, macOS, Linux and WSL.

**Component**: core, extension, plugin

- **16.0.1 (Ubiquitous)**: The system shall give identical sync results on Windows, macOS and Linux desktop, and with the repo and vault on opposite sides of WSL.
- **16.0.2 (Unwanted Behavior)**: If a file name is legal on one side's filesystem but not the other's (reserved Windows names, characters such as `:` or `?`, trailing dots or spaces), then the system shall not sync that file and shall report it.
- **16.0.3 (Unwanted Behavior)**: If two files differ only by case on a case-sensitive side and the other side is case-insensitive, then the system shall sync neither and report the clash.
- **16.0.4 (Unwanted Behavior)**: If a Markdown file isn't valid UTF-8, then the system shall not sync it and shall report it.
- **16.0.5 (Ubiquitous)**: The system shall not follow symbolic links or junctions inside either folder, and shall report any it skips.

#### Acceptance Criteria
- **16.1**: The core sync test suite passes on Windows, macOS and Linux in CI, and a WSL test run passes on Windows.
- **16.2**: A file named `notes:draft.md` created on Linux isn't copied to a Windows vault, and is reported.
- **16.3**: `Plan.md` and `plan.md` together in a Linux repo, linked to a Windows vault, are both reported and neither is copied.
- **16.4**: A Latin-1 encoded `.md` file is reported and not copied.

### REQ-17: Status and problems

**User Story**: As a developer, I want to see at a glance that sync is healthy, and exactly what needs my attention when it isn't.

**Component**: extension, plugin

- **17.0.1 (Ubiquitous)**: The extension shall show a status bar item that reads Up to date, Syncing, Paused, or N items need attention.
- **17.0.2 (Ubiquitous)**: The extension shall list every conflict, held-back change, skipped file and invalid rule in a Project Docs view, each with the action that resolves it.
- **17.0.3 (Ubiquitous)**: The plugin shall show the same overall status in Obsidian's status bar, and a notice on any note whose change is held back or in conflict.
- **17.0.4 (Ubiquitous)**: The system shall keep a log of sync actions that the user can open. The log shall never contain real values from PRIVATE.md.
- **17.0.5 (Event-Driven)**: When the user runs "Project Docs: Pause sync", the system shall stop syncing until resumed, and show Paused.

#### Acceptance Criteria
- **17.1**: Each kind of problem in REQ-5, REQ-8, REQ-13 and REQ-16 appears in the Project Docs view with a working resolve action.
- **17.2**: An edit held back for a real value shows in Obsidian as a notice on the note.
- **17.3**: A scan of the log after the REQ-13 tests finds no real value.

### REQ-18: Sync from the command line

**User Story**: As a coding agent or a developer working without VS Code open, I want to check and run sync from a terminal, so that docs stay current when only an agent is working in the repo.

**Component**: core

- **18.0.1 (Ubiquitous)**: The system shall provide a command-line tool, `project-docs`, built from the shared core, with three commands:
  - `status`: what would sync, and any problems;
  - `sync`: run one sync pass with the same rules and safeguards as the extension, including the bulk-change guard, which needs `--yes` to proceed;
  - `where`: print the vault folder for this repo.
- **18.0.2 (Unwanted Behavior)**: If another sync engine (the extension or another CLI run) is active for the same link, then the command-line tool shall refuse to sync and say which one is active.

#### Acceptance Criteria
- **18.1**: With VS Code closed, an agent edits a repo doc and runs `project-docs sync`. The vault copy updates.
- **18.2**: `project-docs where` prints the vault folder, and exits non-zero with a clear message when the repo isn't linked.
- **18.3**: Running `project-docs sync` while VS Code is syncing the same link is refused with a message naming VS Code.

### REQ-19: Safe operation of the engine

**User Story**: As a developer, I want the sync engine to stay correct through crashes, restarts and multiple windows.

**Component**: core, extension

- **19.0.1 (Ubiquitous)**: The system shall allow at most one active sync engine per link at a time, across VS Code windows and command-line runs, using a lock that is released if its holder dies.
- **19.0.2 (Ubiquitous)**: The system shall store bases, the conflict store and pending passes outside both linked folders, in the extension's or the user's application-data storage.
- **19.0.3 (Unwanted Behavior)**: If the engine stops part-way through a pass (crash, power loss, VS Code closed), then on the next start it shall complete or safely redo the pass, without losing or duplicating any change.
- **19.0.4 (Unwanted Behavior)**: If the engine's stored state is missing or unreadable, then it shall rebuild it by treating the next pass as a first sync (repo primary, conflicts preserved), never by assuming either side is empty.

#### Acceptance Criteria
- **19.1**: Opening the same repo in two VS Code windows results in one engine syncing and the other window showing that sync is handled elsewhere.
- **19.2**: Killing VS Code at random points during a large sync, then restarting, ends with both sides consistent and no change lost (fault-injection test).
- **19.3**: Deleting the engine's stored state and restarting causes no file deletion on either side.

### REQ-20: Performance

**User Story**: As a developer, I want sync to be quick and unnoticeable.

**Component**: core, extension

- **20.0.1 (Ubiquitous)**: The system shall complete a first sync of 1,000 Markdown files of up to 50 KB each in under 30 seconds on a local SSD.
- **20.0.2 (State-Driven)**: While nothing is changing, the extension shall use no noticeable CPU: less than 1% averaged over a minute, with native watching.
- **20.0.3 (Ubiquitous)**: The system shall skip Markdown files larger than 5 MB and report them.

#### Acceptance Criteria
- **20.1**: A benchmark of 1,000 files of 50 KB completes the first sync in under 30 seconds on the CI's reference runner.
- **20.2**: An idle measurement over 60 seconds shows under 1% CPU for the extension host's sync work.
- **20.3**: A 6 MB Markdown file is reported and not copied.

### REQ-21: Quality and distribution

**User Story**: As the maintainer, I want the release to meet the product's bar before it's published.

**Component**: all

- **21.0.1 (Ubiquitous)**: The system shall meet the test coverage targets in the project's testing standards. The sync engine, merge, the private-content guards and the decoder count as critical logic and shall reach 90–100% line coverage.
- **21.0.2 (Ubiquitous)**: The extension shall be published to the VS Code Marketplace, and the plugin to the Obsidian community plugin store, only after every acceptance criterion in this document passes.
- **21.0.3 (Ubiquitous)**: The extension shall run in desktop VS Code only in the first release, and shall decline to activate in browser-based VS Code with a clear message.

#### Acceptance Criteria
- **21.1**: The coverage report shows at least 90% line coverage for the core's sync, merge, guard and decoder modules, and meets the general targets elsewhere.
- **21.2**: The release checklist records a pass for every acceptance criterion before publishing.
- **21.3**: Opening the extension in vscode.dev shows a message that it needs desktop VS Code.
