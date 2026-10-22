# Choose how each file syncs

Every doc syncs both ways unless you say otherwise. A doc's rule is the `project-docs` property in its frontmatter, and you can set it without typing:

- **Right-click** the doc in the Explorer, then **Project Docs Sync Rule**.
- Or click the rule in the **status bar** while the doc is open.

| Rule            | What happens                                                                |
| --------------- | --------------------------------------------------------------------------- |
| `sync`          | Edits in either app are copied to the other. This is the default.           |
| `repo-to-vault` | The repo's copy wins. Edits made in Obsidian are reported, not copied back. |
| `repo-only`     | The doc is never copied to the vault.                                       |
| `private`       | Set in Obsidian: the note never reaches the repo.                           |

Changing a rule changes only that one line of the file.

When something needs you, such as a doc edited differently in both apps, the status bar says so, and the **Project Docs** view in the Explorer lists each item with the action that resolves it.
