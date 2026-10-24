# Link your docs to Obsidian

Project Docs keeps your repo's docs in step with a project folder in your Obsidian vault. Edit a doc in either app and the other gets the change within a couple of seconds.

Linking asks three things:

1. **The docs folder** in this repo, `docs` by default.
2. **The vault**, picked from the vaults Obsidian knows about.
3. **The project folder** in the vault, `Projects/<repo name>` by default. It mirrors the repo: the docs go in its `docs` folder, and the repo's README.md, CHANGELOG.md and RELEASE_NOTES.md at its top.

Two small files record the link:

- `.project-docs.json` is committed. It holds relative paths and settings only, never anything about your machine.
- `.project-docs.local.json` is gitignored. It holds this machine's absolute paths.

In the vault, the project folder's **folder note** (`Projects/<repo>/<repo>.md`) becomes the link note. It records the repo's path and has a link that opens the repo in VS Code. It never syncs to the repo.

Notes you put in the docs folder's `private` subfolder (`docs/private` in the vault) stay in the vault, so you can keep private project notes right beside the docs.
