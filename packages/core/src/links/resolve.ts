/**
 * Resolving link targets to files, the way Obsidian does, so the engine can tell a link into the
 * project folder (convertible) from one to elsewhere in the vault (held back by default, REQ-13.0.2)
 * or to nothing at all.
 *
 * Paths here are vault-relative with `/` separators. Keys inside the project folder are the sync
 * keys used everywhere else.
 */
import * as path from "node:path";
import type { LinkRef } from "./parse.js";

/** What the resolver knows about the vault. */
export interface VaultListing {
  /** The project's folder, vault-relative, without a trailing slash; empty for the vault root. */
  readonly projectFolder: string;
  /** Every file in the vault, vault-relative. */
  readonly files: readonly string[];
}

/** Where a link points. */
export type Resolution =
  | { readonly where: "inside"; readonly key: string }
  | { readonly where: "outside"; readonly vaultPath: string }
  | { readonly where: "missing" }
  | { readonly where: "ambiguous"; readonly candidates: readonly string[] };

/** A link together with where it points. */
export interface ResolvedLink {
  readonly link: LinkRef;
  readonly resolution: Resolution;
}

/** Resolves links found in a note. */
export interface LinkResolver {
  /** `fromKey` is the note's key within the project folder. */
  resolve(link: LinkRef, fromKey: string): Resolution;
}

function withoutMd(file: string): string {
  return file.toLowerCase().endsWith(".md") ? file.slice(0, -3) : file;
}

function dirOf(vaultPath: string): string {
  const slash = vaultPath.lastIndexOf("/");
  return slash === -1 ? "" : vaultPath.slice(0, slash);
}

/** Creates a resolver over a vault listing. */
export function createResolver(listing: VaultListing): LinkResolver {
  const prefix = listing.projectFolder === "" ? "" : `${listing.projectFolder}/`;
  const files = new Set(listing.files);
  // Files by lower-cased last path segment, with and without `.md`: Obsidian matches link text
  // case-insensitively and lets notes omit their extension.
  const byName = new Map<string, string[]>();
  for (const file of listing.files) {
    const lower = file.toLowerCase();
    const name = lower.slice(lower.lastIndexOf("/") + 1);
    for (const key of new Set([name, withoutMd(name)])) {
      byName.set(key, [...(byName.get(key) ?? []), file]);
    }
  }

  const toResolution = (vaultPath: string): Resolution =>
    vaultPath.startsWith(prefix)
      ? { where: "inside", key: vaultPath.slice(prefix.length) }
      : { where: "outside", vaultPath };

  /** Obsidian's rule: a path match first, then any file whose path ends with the link text. */
  function resolveWiki(target: string, fromVaultPath: string): Resolution {
    if (target === "") return toResolution(fromVaultPath);
    const wanted = target.replace(/\\/g, "/").toLowerCase();
    const name = wanted.slice(wanted.lastIndexOf("/") + 1);
    const candidates = (byName.get(name) ?? []).filter((file) => {
      const lower = file.toLowerCase();
      return [lower, withoutMd(lower)].some(
        (form) => form === wanted || form.endsWith(`/${wanted}`),
      );
    });
    if (candidates.length === 0) return { where: "missing" };
    if (candidates.length === 1) return toResolution(candidates[0] ?? "");
    // Several files share the name: Obsidian prefers one in the linking note's folder.
    const sameFolder = candidates.filter((c) => dirOf(c) === dirOf(fromVaultPath));
    if (sameFolder.length === 1) return toResolution(sameFolder[0] ?? "");
    return { where: "ambiguous", candidates: candidates.sort() };
  }

  function resolveRelative(relative: string, fromVaultPath: string): Resolution {
    const joined = path.posix.normalize(
      path.posix.join(dirOf(fromVaultPath), relative.replace(/\\/g, "/")),
    );
    if (joined.startsWith("../") || joined === "..") return { where: "missing" };
    if (files.has(joined)) return toResolution(joined);
    // Markdown links to notes often omit `.md`, as Obsidian allows.
    if (files.has(`${joined}.md`)) return toResolution(`${joined}.md`);
    return { where: "missing" };
  }

  return {
    resolve(link, fromKey) {
      const fromVaultPath = `${prefix}${fromKey}`;
      return link.kind === "wikilink"
        ? resolveWiki(link.target, fromVaultPath)
        : resolveRelative(link.path, fromVaultPath);
    },
  };
}
