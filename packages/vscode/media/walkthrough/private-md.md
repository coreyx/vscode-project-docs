# Keep private values out of the repo

Docs often need things that shouldn't be public: hostnames, internal addresses, account names. **PRIVATE.md** lets the committed docs use placeholders while you still read and write the real thing.

- `PRIVATE.md`, at the repo root, maps each placeholder to its real value. It's **gitignored**, so it never leaves your machine. Keep a copy somewhere safe.
- `PRIVATE.example.md` is committed. It shows the structure with fake values.

```markdown
## Placeholders

| Placeholder in the repo | Real value    | What it is           |
| ----------------------- | ------------- | -------------------- |
| `myhost`                | `DESK-FAKE01` | Workstation hostname |
```

With a PRIVATE.md in place, Project Docs:

- **holds back** any edit from Obsidian that contains a real value, and offers to swap in the placeholder;
- **flags** real values already in the repo's docs in the Problems panel;
- **shows coded docs decoded**, with real values, in a view that can't be saved.

It can also install the standard's commit hooks, which block any commit containing a real value.

PRIVATE.md is an open standard: [the PRIVATE.md standard](https://github.com/coreyx/private-md-standard).
