/**
 * What a link syncs (REQ-22, design decision 21). Keys are paths relative to the repo root, which
 * the vault folder mirrors, and only the docs folder and the root files the link lists are in
 * scope. The same scope applies to both sides by key, so a file is in it on both sides or on
 * neither: a file left out on one side alone would make the planner trash the other copy.
 */

/** Which keys a link syncs. */
export interface Scope {
  /** True when the file at `key` is synced, or could be. */
  includes(key: string): boolean;
  /** True when the folder at `key` may hold something in scope, so the scanner must enter it. */
  mayContain(folderKey: string): boolean;
}

/**
 * The scope for a docs folder, relative to the repo root (`""` for the root itself), and the
 * Markdown files at the top of the repo root that sync too. A repo-root link has everything in
 * scope, so its root files are already in it.
 */
export function createScope(docsFolder: string, rootFiles: readonly string[]): Scope {
  const docs = docsFolder.split("/").filter(Boolean).join("/");
  if (docs === "") return { includes: () => true, mayContain: () => true };
  const roots = new Set(rootFiles);
  const inside = `${docs}/`;
  return {
    includes: (key) => key.startsWith(inside) || (!key.includes("/") && roots.has(key)),
    // The docs folder's ancestors lead to it; everything below it is in it.
    mayContain: (folder) =>
      folder === docs || folder.startsWith(inside) || inside.startsWith(`${folder}/`),
  };
}

/** The private subfolder's key: the setting is relative to the docs folder (decision 21). */
export function privateFolderKey(docsFolder: string, privateSubfolder: string): string {
  return [...docsFolder.split("/"), privateSubfolder].filter(Boolean).join("/");
}
