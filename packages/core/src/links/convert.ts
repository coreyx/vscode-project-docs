/**
 * Converting wikilinks to standard Markdown links (REQ-12), and listing every link's target for
 * the privacy guards (REQ-13).
 *
 * Synced docs use standard Markdown links because GitHub and Obsidian both render them. A wikilink
 * is converted only when its target is a synced file inside the project folder; anything else is
 * left exactly as written and reported, for the user or the guards to decide.
 */
import * as path from "node:path";
import { findLinks, findWikiLinks, protectedRanges, type WikiLink } from "./parse.js";
import type { LinkResolver, ResolvedLink } from "./resolve.js";

/** A wikilink left as written, and why. */
export interface UnconvertibleLink {
  readonly link: WikiLink;
  readonly reason: string;
}

/** The result of converting one document. */
export interface ConversionResult {
  readonly text: string;
  readonly converted: number;
  readonly unconvertible: readonly UnconvertibleLink[];
}

/**
 * GitHub's heading anchor: lower case, punctuation removed, spaces as hyphens. Converted links use
 * this form because the repo is primary; Obsidian still opens the note from such a link.
 */
export function headingAnchor(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

function encodePath(relative: string): string {
  return relative
    .split("/")
    .map((segment) => (segment === ".." || segment === "." ? segment : encodeURIComponent(segment)))
    .join("/");
}

function escapeLinkText(text: string): string {
  return text.replace(/[[\]\\]/g, "\\$&");
}

function dirOf(key: string): string {
  const slash = key.lastIndexOf("/");
  return slash === -1 ? "" : key.slice(0, slash);
}

/** Builds the Markdown for one convertible wikilink, or returns why it can't be converted. */
function markdownFor(
  link: WikiLink,
  fromKey: string,
  resolver: LinkResolver,
): string | { reason: string } {
  if (link.block !== undefined) {
    return { reason: "a block reference has no Markdown equivalent" };
  }
  const anchor = link.heading ? `#${headingAnchor(link.heading)}` : "";
  const shown = link.alias ?? link.raw.replace(/^!?\[\[|\]\]$/g, "").split("|")[0] ?? "";
  if (link.target === "") {
    // `[[#Heading]]`: a link within the same note.
    return `[${escapeLinkText(link.alias ?? link.heading ?? "")}](${anchor})`;
  }
  const resolution = resolver.resolve(link, fromKey);
  switch (resolution.where) {
    case "missing":
      return { reason: "the target doesn't exist" };
    case "ambiguous":
      return { reason: `several files match: ${resolution.candidates.join(", ")}` };
    case "outside":
      return { reason: "the target is outside the project folder" };
    case "inside": {
      const isNote = resolution.key.toLowerCase().endsWith(".md");
      if (link.embed && isNote) return { reason: "an embedded note has no Markdown equivalent" };
      const relative = path.posix.relative(dirOf(fromKey), resolution.key);
      const destination = `${encodePath(relative)}${anchor}`;
      if (link.embed) {
        const alt = link.alias ?? resolution.key.slice(resolution.key.lastIndexOf("/") + 1);
        return `![${escapeLinkText(alt)}](${destination})`;
      }
      return `[${escapeLinkText(shown)}](${destination})`;
    }
  }
}

/**
 * Converts the wikilinks and embeds in a note to Markdown links where possible (REQ-12.0.1),
 * leaving the rest of the text byte-identical. With `keepLinksAsWritten`, nothing is converted.
 */
export function convertWikilinks(
  text: string,
  fromKey: string,
  resolver: LinkResolver,
  options: { readonly keepLinksAsWritten: boolean },
): ConversionResult {
  if (options.keepLinksAsWritten) return { text, converted: 0, unconvertible: [] };
  const unconvertible: UnconvertibleLink[] = [];
  const edits: { start: number; end: number; replacement: string }[] = [];
  for (const link of findWikiLinks(text, protectedRanges(text))) {
    const result = markdownFor(link, fromKey, resolver);
    if (typeof result === "string")
      edits.push({ start: link.start, end: link.end, replacement: result });
    else unconvertible.push({ link, reason: result.reason });
  }
  let output = text;
  // Apply from the end, so earlier offsets stay valid.
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
    output = output.slice(0, edit.start) + edit.replacement + output.slice(edit.end);
  }
  return { text: output, converted: edits.length, unconvertible };
}

/** Lists every link in a note with where it points, for the privacy guards (REQ-13). */
export function linkTargets(text: string, fromKey: string, resolver: LinkResolver): ResolvedLink[] {
  return findLinks(text).map((link) => ({ link, resolution: resolver.resolve(link, fromKey) }));
}
