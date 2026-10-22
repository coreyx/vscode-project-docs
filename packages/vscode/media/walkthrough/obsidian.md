# Jump to the project in Obsidian

**Open in Obsidian** opens the project's folder note in your vault. From there, the note's "Open the repo in VS Code" link brings you back.

By default it uses Obsidian's own `obsidian://open` link, built from this machine's link file.

If the vault has the **Advanced URI** plugin, Project Docs offers deep links instead. The project's id goes into the folder note as `uid: <project id>`, and the committed `.project-docs.json` gets an `obsidian://adv-uri?uid=…` link. That link finds the folder note even after you rename or move the folder, and names no vault, so it's safe to commit.

If you add the `uid` by hand, put it in the project folder's **folder note**, so the link stays anchored to the project folder.
