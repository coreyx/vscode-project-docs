# Link your docs to Obsidian

Project Docs keeps two folders in step: your repo's docs folder and a folder in your Obsidian vault. Edit a doc in either app and the other gets the change within a couple of seconds.

Linking asks three things:

1. **The docs folder** in this repo, `docs` by default.
2. **The vault**, picked from the vaults Obsidian knows about.
3. **The vault folder**, `Projects/<repo name>` by default.

Two small files record the link:

- `.project-docs.json` is committed. It holds relative paths and settings only, never anything about your machine.
- `.project-docs.local.json` is gitignored. It holds this machine's absolute paths.

In the vault, the project folder's **folder note** (`Projects/<repo>/<repo>.md`) becomes the link note. It records the repo's path and has a link that opens the repo in VS Code. It never syncs to the repo.

Notes you put in the folder's `private` subfolder stay in the vault, so you can keep private project notes right beside the docs.
