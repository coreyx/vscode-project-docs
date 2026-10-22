---
status: approved
---

# Implementation Tasks: Project Docs

This document defines the implementation plan as a numbered checklist. Each task is linked to one or more acceptance criteria from [`requirements.md`](./requirements.md), and follows [`design.md`](./design.md) and [`tech.md`](./tech.md).

Every task includes its own unit and integration tests in the project's real test framework (Vitest for core and CLI, `@vscode/test-cli` for the extension). A task is done only when its tests pass on the CI matrix.

**Coverage targets:**
- 90–100% line coverage for the critical modules: `plan/`, `exec/`, `merge/`, `guards/`, `privatemd/`, `state/`, `lock/`;
- 70–85% line and 60–80% branch coverage elsewhere.

The Obsidian plugin is implemented in `obsidian-project-docs` under its own spec (TASK-30). Acceptance criteria that only the plugin can satisfy are listed there, and verified end to end in TASK-31.

## Task List

### Milestone 1: The repository builds and tests on every platform

- [x] **TASK-1: Set up the workspace**
  - **Associated Acceptance Criteria**: none (project setup)
  - **Concrete Steps**:
    1. Create npm workspaces `packages/core`, `packages/cli` and `packages/vscode`. Name them `@specdevship/project-docs-core`, `@specdevship/project-docs-cli` and the extension `project-docs`.
    2. Configure TypeScript in strict mode with a shared base `tsconfig`, plus ESLint and Prettier.
    3. Add esbuild builds for the CLI bundle, the extension's Node entry, and its web stub entry.
    4. Add Vitest with V8 coverage, and per-module thresholds matching the coverage targets above.
    5. Add `LICENSE` (MIT, Corey Struzan), a `README.md` stub, `CHANGELOG.md` with `## [Unreleased]`, and `.gitignore`.
    6. Vendor the PRIVATE.md standard's `conformance/cases/` into `packages/core/test/conformance/`. Mark them `-text` in `.gitattributes`, and record the source commit in a `SOURCE` file.

- [x] **TASK-2: Set up CI on Windows, macOS, Linux and WSL**
  - **Associated Acceptance Criteria**: `16.1`, `21.1`
  - **Concrete Steps**:
    1. Add a GitHub Actions workflow that runs lint, build and tests on `windows-latest`, `macos-latest` and `ubuntu-latest`, with the oldest supported Node (22) and the current LTS.
    2. Add a Windows job that installs a WSL distribution and runs the core tests inside it, with one fixture folder on `/mnt/c` and one in the WSL filesystem.
    3. Run the extension integration tests headlessly on all three operating systems.
    4. Fail the build when a coverage threshold isn't met, and publish the coverage report as an artifact.

### Milestone 2: The core can read and write both sides safely

- [x] **TASK-3: Add path handling (`paths/`)**
  - **Associated Acceptance Criteria**: `6.2`, `16.2`, `16.3`
  - **Concrete Steps**:
    1. Implement canonical keys: relative to the linked folder, `/` separators, Unicode NFC.
    2. Implement case-folded keys and clash detection for case-insensitive targets.
    3. Implement portability checks for Windows targets: reserved names (`CON`, `PRN`, `AUX`, `NUL`, `COM1`–`COM9`, `LPT1`–`LPT9`), the characters `<>:"/\|?*` and control characters, and a trailing dot or space.
    4. Implement WSL translation (`wslpath` in WSL, `\\wsl.localhost\<distro>\` on Windows), `isWindowsFs` detection (Windows, or `/mnt/<drive>` in WSL), and case-sensitivity probing that never writes to the user's folders.
    5. Unit-test every rule, including `notes:draft.md`, `Plan.md`/`plan.md`, and a case-only rename key.

- [x] **TASK-4: Add the side filesystem adapter (`sidefs/`)**
  - **Associated Acceptance Criteria**: `3.3`, `6.3`
  - **Concrete Steps**:
    1. Define the `SideFs` interface as in design.md.
    2. Implement the Node adapter:
       - `writeAtomic`: a temporary file in the same folder, `fsync`, then rename, with retries on Windows sharing violations;
       - `rename`, including case-only renames through a temporary name;
       - `list`, which never follows symlinks or junctions.
    3. Implement trash strategies:
       - a vault-side mover into `<vault>/.trash/`, adding a timestamp suffix when the name is taken;
       - injection points for VS Code's trash and the `trash` package.
    4. Stress-test atomicity: a reader polling a file during 1,000 writes never sees a partial file.

- [x] **TASK-5: Add the scanner (`scan/`)**
  - **Associated Acceptance Criteria**: `3.4`, `16.4`, `20.3`
  - **Concrete Steps**:
    1. Walk a side into a `Snapshot`, keeping the on-disk case.
    2. Hash Markdown as SHA-256 over line-ending-normalized UTF-8, and other files over raw bytes. Record each file's line-ending style.
    3. Add a stat cache (size and modification time) to skip re-hashing unchanged files.
    4. Skip and report:
       - symlinks and junctions;
       - non-UTF-8 Markdown;
       - files over 5 MB.
    5. Always exclude, without reporting:
       - the `.project-docs/` folder;
       - `.obsidian/` and `.trash/`;
       - `PRIVATE.md`, `PRIVATE.example.md` and `*.private.md`.
    6. Classify files as Markdown or attachment, and tag the link note by path.

- [x] **TASK-6: Add the state store and engine lock (`state/`, `lock/`)**
  - **Associated Acceptance Criteria**: `19.1`, `19.3`
  - **Concrete Steps**:
    1. Resolve the per-user app-data folder (`%APPDATA%`, `~/Library/Application Support`, `$XDG_DATA_HOME`) with a `project-docs/projects/<projectId>/` subfolder.
    2. Implement the index (written atomically), the content-addressed blob store, conflict records, `journal.json`, `pending-bulk.json` and garbage collection of unreferenced blobs.
    3. Treat a missing or unreadable index as empty: log it and continue (design decision 10).
    4. Implement the lock:
       - exclusive create of `lock.json` holding `pid`, `host`, `owner` and `heartbeatAt`;
       - a heartbeat every 10 seconds;
       - stale after 30 seconds or when the holder's process is gone;
       - return `LockHeldBy` with the owner.
    5. Test that two processes contend correctly, a killed holder's lock is taken over, and deleting the state folder causes no file deletions in the following pass.

- [x] **TASK-7: Add the redacting logger (`log/`)**
  - **Associated Acceptance Criteria**: `17.3`
  - **Concrete Steps**:
    1. Implement a rotating file logger in the state folder.
    2. Pass every message through a redactor that replaces each real value from the current PRIVATE.md mapping (case-insensitive) with its placeholder, before writing.
    3. Test that logging a message containing real values in mixed case writes only placeholders.

### Milestone 3: Rules, links and privacy checks work in isolation

- [x] **TASK-8: Add sync rules in frontmatter (`rules/`)**
  - **Associated Acceptance Criteria**: `8.1`, `8.4`, `9.2`
  - **Concrete Steps**:
    1. Parse the frontmatter block's boundaries exactly, and read `project-docs` with the `yaml` Document API.
    2. Return `sync` when the property is absent, `InvalidRule` with the value for anything outside the four rules, and the rule otherwise.
    3. Implement `setRule`, which edits only the property. Create a frontmatter block when there isn't one. Preserve line endings, comments and the order of other properties.
    4. Implement a generic property merge for the link note's properties, reused by TASK-16.
    5. Test byte-identity outside the property across files with and without frontmatter, with CRLF, comments and unusual YAML.

- [x] **TASK-9: Port the PRIVATE.md decoder and value finder (`privatemd/`)**
  - **Associated Acceptance Criteria**: `14.1`, `13.3`
  - **Concrete Steps**:
    1. Port `load_placeholders`, `parse_code_span`, `placeholder_pattern` (`[\p{L}\p{N}]` boundaries) and `restore` from the reference implementation, with errors carrying the standard's `kind`s.
    2. Run every vendored conformance case byte for byte in the test suite.
    3. Implement `findRealValues`: case-insensitive, values of at least 4 characters, findings naming placeholders only.
    4. Implement `replaceRealValues`, the inverse used for the hold-back fix: longest real value first, with the standard's boundary rule.
    5. Add a differential test that runs the reference Python script against the TypeScript decoder on generated inputs, where Python is available in CI. Record any disagreement as a new conformance case.

- [x] **TASK-10: Add link parsing and conversion (`links/`)**
  - **Associated Acceptance Criteria**: `12.1`, `12.2`, `12.3`, `12.4`
  - **Concrete Steps**:
    1. Build code, inline-code and frontmatter ranges, plus Markdown links, with `mdast-util-from-markdown`, `micromark-extension-gfm` and `micromark-extension-frontmatter`.
    2. Tokenize Obsidian syntax outside those ranges: `[[target]]`, `[[target|alias]]`, `[[target#heading]]`, `[[target#^block]]` and `![[embed]]`.
    3. Resolve targets against a snapshot using Obsidian's rules (shortest unique path, `.md` optional).
    4. Convert eligible wikilinks to relative Markdown links as positional edits. Percent-encode spaces, keep alias text, and map heading anchors.
    5. List every link target, with its resolved location (inside the folder, private, outside the folder, or missing), for the guards.
    6. Respect `keepLinksAsWritten`.
    7. Test the four acceptance examples, plus links inside code blocks, which must stay untouched.

- [x] **TASK-11: Add the privacy guards (`guards/`)**
  - **Associated Acceptance Criteria**: `2.9`, `3.4`, `10.1`, `10.2`, `10.3`, `11.3`, `13.1`, `13.2`, `13.3`
  - **Concrete Steps**:
    1. Implement `guards.check(change)`, returning hold-back or skip reasons for each of:
       - a file inside the private subfolder;
       - a `private` marker;
       - a path or hash on the private-files list;
       - the link note;
       - the never-synced names;
       - a link or embed to a private target;
       - a link to a target outside the folder (unless allowed);
       - a real value.
    2. Make every reason carry placeholders, never real values.
    3. Read `.project-docs/private-files.json` defensively. Treat an invalid list as "hold back every attachment" rather than "allow".
    4. Unit-test each reason, and the private-file move, rename and duplicate cases.

### Milestone 4: The sync engine plans, merges and executes passes correctly

- [ ] **TASK-12: Add the three-way merge (`merge/`)**
  - **Associated Acceptance Criteria**: `5.1`
  - **Concrete Steps**:
    1. Wrap `node-diff3` on LF-normalized line arrays, returning a clean result or conflict hunks.
    2. Test non-overlapping edits, overlapping edits, identical edits, empty files, and files without a trailing newline.

- [ ] **TASK-13: Add the planner (`plan/`)**
  - **Associated Acceptance Criteria**: `1.3`, `4.1`, `5.1`, `5.2`, `6.1`, `6.4`, `7.1`, `8.2`, `8.3`, `11.1`, `11.2`
  - **Concrete Steps**:
    1. Implement the decision table in design.md for Markdown, and the rule modifiers (`repo-only`, `repo-to-vault`, `private`).
    2. Implement rename detection by base hash per side, and case-only renames.
    3. Implement first-sync handling for keys with no base (decision 10).
    4. Run guards on every vault-to-repo change, and freeze held-back and conflicted keys in both directions (decision 5).
    5. Emit `writeBoth` for wikilink conversions (decision 6) and clean merges.
    6. Emit the decision 9 report when a synced note becomes private.
    7. Handle attachments: excluded unless `syncAttachments` is on; otherwise whole-file copy, with a conflict when both sides changed.
    8. Compute the bulk guard (decision 12).
    9. Make the planner pure: no I/O apart from the injected content reader.

- [ ] **TASK-14: Add the executor and journal (`exec/`)**
  - **Associated Acceptance Criteria**: `3.2`, `19.2`
  - **Concrete Steps**:
    1. Persist the plan to `journal.json` before the first action.
    2. Apply each action idempotently (skip when the target already has the intended hash), update the index, and mark the action done.
    3. On start, replay an unfinished journal before planning.
    4. Write each side's recorded line-ending style, or the side's default for new files.
    5. Write `.project-docs/status.json` after every pass, with no real values.
    6. Retry failed writes on the next pass, and surface repeated failures.

- [ ] **TASK-15: Add property-based and fault-injection tests**
  - **Associated Acceptance Criteria**: `5.4`, `19.2`, `19.3`, `21.1`
  - **Concrete Steps**:
    1. Build a fast-check model that generates histories of edits, renames, deletes, rule changes, private moves and restarts on both sides, against real temporary folders.
    2. Assert the no-loss invariant after every history: every version written by either side is on disk, in the conflict store, or in a trash.
    3. Assert the privacy invariant: no private content, private link or real value ever reaches the repo folder.
    4. Inject faults by killing the executor at random action boundaries and mid-write through a faulty `SideFs`. Assert consistency after replay.
    5. Delete the state at random points, and assert that no file is deleted on either side.
    6. Confirm that coverage of the critical modules is at least 90%.

- [ ] **TASK-16: Add the link records (`records/`)**
  - **Associated Acceptance Criteria**: `2.1`, `2.2`, `2.5`, `2.6`, `2.7`, `2.8`, `2.9`
  - **Concrete Steps**:
    1. Implement the committed `.project-docs.json` and the local `.project-docs.local.json` with JSON schemas, a `format` field and `description` text. Reject absolute paths in the committed file.
    2. Add `.project-docs.local.json` to `.gitignore` when it isn't already ignored (`git check-ignore`).
    3. Write the link note as the folder note, following `folderNotePattern`. Merge the properties into an existing note without changing its other content, and add the "Open repo in VS Code" link once.
    4. Write `uid` and `deepLink` only while `advancedUriDeepLinks` is on.
    5. Detect a missing local file with the committed file present, and return a re-link state that keeps `projectId`.
    6. Test that the committed file contains no drive letter, home path or vault name after linking.

### Milestone 5: Agents and terminals can sync without VS Code

- [ ] **TASK-17: Add the CLI (`packages/cli`)**
  - **Associated Acceptance Criteria**: `7.2`, `18.1`, `18.2`, `18.3`
  - **Concrete Steps**:
    1. Implement `status`, `sync` and `where` with `util.parseArgs`, `--json`, and the exit codes from design.md.
    2. Have `sync` acquire the lock as `cli`, replay any journal, plan, stop with exit code 2 at the bulk guard unless `--yes` is given, execute, and release.
    3. Use the `trash` package for repo-side deletes.
    4. Integration-test the three commands, the lock refusal (naming VS Code), and the not-linked error.

- [ ] **TASK-18: Add a performance benchmark**
  - **Associated Acceptance Criteria**: `20.1`
  - **Concrete Steps**:
    1. Add a benchmark that creates 1,000 Markdown files of 50 KB and times the first sync through the core.
    2. Run it in CI on the Linux runner and fail it above 30 seconds. Report Windows and macOS times without failing.

### Milestone 6: The extension links projects and keeps them in sync

- [ ] **TASK-19: Set up the extension skeleton**
  - **Associated Acceptance Criteria**: `21.3`
  - **Concrete Steps**:
    1. Write the `package.json` contributions:
       - `extensionKind: ["workspace"]`;
       - activation on `workspaceContains:.project-docs.json` and on the link command;
       - commands, menus, the view and the walkthrough from design.md.
    2. Add the `main` Node entry, and the `browser` stub that only shows "Project Docs needs desktop VS Code".
    3. Set the VS Code engine floor (stable release six months before the first publish).
    4. Add an integration test that the web stub shows the message.

- [ ] **TASK-20: Add the link service**
  - **Associated Acceptance Criteria**: `1.1`, `1.2`, `1.4`, `1.5`, `2.5`
  - **Concrete Steps**:
    1. Read Obsidian's vault registry on Windows, macOS, Linux (including Flatpak and Snap paths) and from WSL through `/mnt/<drive>`.
    2. Implement "Link to Obsidian": at most four prompts with defaults (docs folder, vault, remembered last vault, vault folder), refusing nested folders by comparing real paths.
    3. Implement "Unlink": stop the engine and remove the records, without touching other files.
    4. Show the re-link prompt for a missing local file, keeping `projectId`.

- [ ] **TASK-21: Add watching and the sync controller**
  - **Associated Acceptance Criteria**: `3.1`, `4.2`, `4.3`, `19.1`, `20.2`
  - **Concrete Steps**:
    1. Add `FileSystemWatcher`s for the docs folder and the vault folder, switching to the core's 5-second poller for vault paths under `/mnt/` or on network drives.
    2. Implement `SyncController`:
       - take the lock and keep its heartbeat;
       - debounce dirty paths by 300 ms;
       - run passes and the 10-minute rescan;
       - pause and resume;
       - show "Sync handled by another window", and take over when the holder goes stale.
    3. Measure idle CPU over 60 seconds in an integration test (under 1%).
    4. Integration-test 2-second propagation on a local disk, and 10-second propagation from WSL to a vault on `C:` in the WSL CI job.

- [ ] **TASK-22: Add conflict resolution and the bulk-change prompt**
  - **Associated Acceptance Criteria**: `5.2`, `5.3`, `7.1`, `7.2`
  - **Concrete Steps**:
    1. Implement `MergeOpener`:
       - open `_open.mergeEditor` with `project-docs-conflict:` documents and an output working file;
       - add the "Complete merge" command, which writes the result to both sides;
       - fall back to a conflict-marker file, and refuse to complete while markers remain.
    2. Add a smoke test that fails loudly when `_open.mergeEditor` stops opening the editor.
    3. Implement the bulk-guard prompt: a summary of what would be deleted and overwritten, Proceed or Cancel, and a pending state in the status bar.

### Milestone 7: The extension shows status, rules, privacy problems and decoded views

- [ ] **TASK-23: Add the status bar, the Project Docs view and the log**
  - **Associated Acceptance Criteria**: `17.1`
  - **Concrete Steps**:
    1. Add a status bar item showing Up to date, Syncing, Paused or N need attention, which opens the view.
    2. Add a `projectDocs.problems` tree with one item per conflict, held-back change, skip and invalid rule, each with its resolve action.
    3. Add "Show log", which opens the redacted log.

- [ ] **TASK-24: Add rule controls in VS Code**
  - **Associated Acceptance Criteria**: `9.1`, `9.2`
  - **Concrete Steps**:
    1. Add an Explorer context submenu for `.md` files in the docs folder (`sync`, `repo-to-vault`, `repo-only`), and the current file's rule in the status bar, with a picker on click.
    2. Write rules through `setRule`.
    3. Add the "no longer synced: move repo copy to trash" offer (decision 9), and the `repo-only` vault-copy trash confirmation.
    4. Test that each change takes at most three clicks and changes only the property.

- [ ] **TASK-25: Add privacy diagnostics and the real-value fix**
  - **Associated Acceptance Criteria**: `13.3`, `13.4`
  - **Concrete Steps**:
    1. Add diagnostics on repo docs that contain real values or link to private notes, naming placeholders only.
    2. Offer "Replace real values with placeholders" on a change held back for real values, applying `replaceRealValues` to the vault file.
    3. Test that the hostname case from 13.3 ends synced, and that no real value appears in the UI or the log.

- [ ] **TASK-26: Add decoded views in VS Code**
  - **Associated Acceptance Criteria**: `14.2`, `14.4`, `15.3`
  - **Concrete Steps**:
    1. Add a `TextDocumentContentProvider` for `project-docs-decoded:`, with live refresh when the source or PRIVATE.md changes, and a tab title ending "(Decoded: real values shown)".
    2. Add an editor-title toggle shown only when the repo has a valid PRIVATE.md, a status-bar Coded/Decoded indicator, and a decoded Markdown preview command.
    3. Show the standard's error for a missing or invalid PRIVATE.md, and no decoded content.
    4. Test that typing into the decoded document is impossible and the file on disk is unchanged.

- [ ] **TASK-27: Add PRIVATE.md setup, the walkthrough and Open in Obsidian**
  - **Associated Acceptance Criteria**: `2.4`, `2.6`, `15.1`, `15.2`
  - **Concrete Steps**:
    1. Implement "Set up PRIVATE.md": create `PRIVATE.md` with an empty table, create `PRIVATE.example.md`, and add the `.gitignore` entries.
    2. Bundle the standard's three scripts with attribution. Make a one-time, dismissible offer to run `install-hooks` with Python, and explain when Python is missing.
    3. Add the `gettingStarted` walkthrough covering linking, sync rules and PRIVATE.md.
    4. Implement "Open in Obsidian":
       - with the deep-link setting on, use the `obsidian://adv-uri?uid=` link;
       - otherwise, use `obsidian://open` built from the local file.

       Test the "open repo" link in the link note on each platform, including a WSL repo opened from Windows.

- [ ] **TASK-28: Write the documentation and run the agent test**
  - **Associated Acceptance Criteria**: `2.3`, `2.10`
  - **Concrete Steps**:
    1. Write the extension `README.md`, covering:
       - linking;
       - sync rules;
       - privacy guarantees;
       - PRIVATE.md;
       - the CLI;
       - the link files for agents;
       - folder-note guidance: `uid: <project id>` belongs in the project folder's folder note.

       Put the same folder-note guidance in the deep-link setting's description.
    2. Write the CLI's `README.md`.
    3. Run the agent test: a fresh agent session is given only a linked repo, and asked to find and update a vault-only note. Record the transcript summary and result in the walkthrough.

### Milestone 8: The Obsidian plugin is specified and built against the core

- [ ] **TASK-29: Publish a prerelease of the core**
  - **Associated Acceptance Criteria**: none (packaging for the plugin)
  - **Concrete Steps**:
    1. Create the `specdevship` npm organization, if it doesn't exist yet. This is a manual step for the maintainer.
    2. Publish `@specdevship/project-docs-core` as a `0.x` prerelease, with type declarations and the exports the plugin needs: rules, records, privatemd, guards (formats only), links (targets).
    3. Document the plugin-facing API in the core's README.

- [ ] **TASK-30: Hand the plugin off to its own spec**
  - **Associated Acceptance Criteria**: `9.1`, `9.3`, `10.1`, `10.3`, `11.3`, `14.3`, `15.3`, `17.2`, `2.10`
  - **Concrete Steps**:
    1. Create a spec folder in `obsidian-project-docs` with a light-tier plan or full-tier documents, as `idea-analysis` decides there. It links back to this spec's `product.md`, `requirements.md` and `design.md` rather than restating them.
    2. List the acceptance criteria the plugin owns: the ones above, and the plugin side of 2.4 and 2.8.
    3. Make the first plugin task the reading-view decoding prototype (design decision 14).
    4. Track the plugin spec's completion here. This task is done when the plugin's spec is implemented and its walkthrough records those criteria as passing.

### Milestone 9: Project Docs is verified end to end and published

- [ ] **TASK-31: Verify the release and publish**
  - **Associated Acceptance Criteria**: `21.2`, `3.1`, `10.1`, `11.1`, `11.2`, `13.1`
  - **Concrete Steps**:
    1. Install the built extension and plugin on Windows, macOS, Linux, and Windows with a WSL repo. Run every acceptance criterion in `requirements.md` end to end, and record pass or fail in a release checklist.
    2. Fix or explicitly defer (with your agreement) anything that fails, before publishing.
    3. Publish the extension to the VS Code Marketplace and `@specdevship/project-docs-cli` to npm, release the core as `1.0.0`, and submit the plugin to the Obsidian community store.
