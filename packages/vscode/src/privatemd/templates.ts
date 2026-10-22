/**
 * The files "Set up PRIVATE.md" creates (REQ-15.0.3), following the standard's layout (§3, §4).
 * Plain functions with no VS Code dependency, so they can be unit-tested.
 */

/** Where the PRIVATE.md standard is published. */
export const STANDARD_URL = "https://github.com/coreyx/private-md-standard";

/** What `.gitignore` must contain, per the standard (§3). */
export const GITIGNORE_ENTRIES = ["PRIVATE.md", "*.private.md"] as const;

const TABLE_HEAD = ["| Placeholder in the repo | Real value | What it is |", "| --- | --- | --- |"];

/** PRIVATE.md with an empty placeholder table, ready for the first row. */
export function privateMdTemplate(eol: string): string {
  return [
    "# Private values",
    "",
    "The real values behind this repo's coded docs. This file is gitignored, so git can't restore it:",
    "keep a copy somewhere safe, such as a password manager.",
    "",
    `Each row maps a placeholder used in the docs to its real value. See ${STANDARD_URL}.`,
    "",
    "## Placeholders",
    "",
    ...TABLE_HEAD,
    "",
    "## Notes",
    "",
    "Anything here is private and ignored by tools.",
    "",
  ].join(eol);
}

/** PRIVATE.example.md: the same structure with an obviously fake row, committed as a guide. */
export function privateExampleTemplate(eol: string): string {
  return [
    "# Private values (example)",
    "",
    "The structure of this repo's PRIVATE.md, with fake values. To restore a working copy, copy this",
    "file to PRIVATE.md and replace each real value. PRIVATE.md itself is gitignored.",
    "",
    `See ${STANDARD_URL}.`,
    "",
    "## Placeholders",
    "",
    ...TABLE_HEAD,
    "| `myhost` | `DESK-FAKE01` | Example: a workstation's hostname |",
    "",
  ].join(eol);
}
