/**
 * Finding links in Markdown without being fooled by code (TASK-10, design.md `links/`).
 *
 * The Markdown parser (mdast) supplies the ranges that aren't prose (code blocks, inline code,
 * frontmatter, raw HTML) and the standard Markdown links and images. Obsidian's `[[wikilinks]]`
 * aren't Markdown, so a small tokenizer finds them in whatever text lies outside those ranges.
 * Everything is reported with exact offsets, so callers can edit text positionally.
 */
import { fromMarkdown } from "mdast-util-from-markdown";
import { frontmatterFromMarkdown } from "mdast-util-frontmatter";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { frontmatter } from "micromark-extension-frontmatter";
import { gfm } from "micromark-extension-gfm";
import { visit } from "unist-util-visit";
import type { Nodes } from "mdast";

/** An Obsidian wikilink or embed, with its parts and where it is. */
export interface WikiLink {
  readonly kind: "wikilink";
  readonly start: number;
  readonly end: number;
  readonly raw: string;
  /** True for `![[…]]`. */
  readonly embed: boolean;
  /** The note or file part, as written (`folder/Note`, `diagram.png`); empty for `[[#Heading]]`. */
  readonly target: string;
  readonly heading?: string | undefined;
  /** The block id of `[[Note#^id]]`, without the caret. */
  readonly block?: string | undefined;
  readonly alias?: string | undefined;
}

/** A standard Markdown link or image whose destination is a relative path. */
export interface MarkdownLink {
  readonly kind: "markdown";
  readonly start: number;
  readonly end: number;
  readonly embed: boolean;
  /** The destination, percent-decoded, without any `#fragment`. */
  readonly path: string;
}

export type LinkRef = WikiLink | MarkdownLink;

type Range = readonly [number, number];

function parse(text: string) {
  return fromMarkdown(text, {
    extensions: [gfm(), frontmatter(["yaml"])],
    mdastExtensions: [gfmFromMarkdown(), frontmatterFromMarkdown(["yaml"])],
  });
}

function offsets(node: Nodes): Range | null {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  return start === undefined || end === undefined ? null : [start, end];
}

/** True for a destination that points into the vault or repo rather than somewhere else. */
function isRelativeDestination(url: string): boolean {
  if (url === "" || url.startsWith("#") || url.startsWith("/") || url.startsWith("\\"))
    return false;
  // Any scheme (https:, mailto:, obsidian:, vscode:) or a Windows drive is not a relative path.
  return !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(url);
}

function decodePath(url: string): string {
  const withoutFragment = url.split("#")[0] ?? "";
  try {
    return decodeURIComponent(withoutFragment);
  } catch {
    return withoutFragment;
  }
}

/** Ranges of the text where links must not be looked for, sorted by start. */
export function protectedRanges(text: string): Range[] {
  const ranges: Range[] = [];
  visit(parse(text), (node) => {
    if (
      node.type === "code" ||
      node.type === "inlineCode" ||
      node.type === "yaml" ||
      node.type === "html"
    ) {
      const range = offsets(node);
      if (range) ranges.push(range);
    }
  });
  return ranges.sort((a, b) => a[0] - b[0]);
}

// `[[…]]` with no line break or nested brackets inside; `!` before it makes an embed.
const WIKILINK = /(!?)\[\[([^[\]\n\r]+?)\]\]/g;

function splitWikiBody(body: string): Pick<WikiLink, "target" | "heading" | "block" | "alias"> {
  const pipe = body.indexOf("|");
  const destination = pipe === -1 ? body : body.slice(0, pipe);
  const alias = pipe === -1 ? undefined : body.slice(pipe + 1);
  const hash = destination.indexOf("#");
  const target = (hash === -1 ? destination : destination.slice(0, hash)).trim();
  const fragment = hash === -1 ? undefined : destination.slice(hash + 1).trim();
  if (fragment?.startsWith("^")) return { target, block: fragment.slice(1), alias };
  return { target, heading: fragment, alias };
}

/** Finds Obsidian wikilinks and embeds outside code, frontmatter and HTML. */
export function findWikiLinks(text: string, ranges: Range[] = protectedRanges(text)): WikiLink[] {
  const links: WikiLink[] = [];
  for (const match of text.matchAll(WIKILINK)) {
    const start = match.index;
    const end = start + match[0].length;
    if (ranges.some(([from, to]) => start < to && end > from)) continue;
    links.push({
      kind: "wikilink",
      start,
      end,
      raw: match[0],
      embed: match[1] === "!",
      ...splitWikiBody(match[2] ?? ""),
    });
  }
  return links;
}

/** Finds standard Markdown links, images and link definitions whose destinations are relative. */
export function findMarkdownLinks(text: string): MarkdownLink[] {
  const links: MarkdownLink[] = [];
  visit(parse(text), (node) => {
    if (node.type === "link" || node.type === "image" || node.type === "definition") {
      if (!isRelativeDestination(node.url)) return;
      const range = offsets(node);
      if (!range) return;
      links.push({
        kind: "markdown",
        start: range[0],
        end: range[1],
        embed: node.type === "image",
        path: decodePath(node.url),
      });
    }
  });
  return links.sort((a, b) => a.start - b.start);
}

/** Every link in a document, wikilinks and Markdown links together, in document order. */
export function findLinks(text: string): LinkRef[] {
  const ranges = protectedRanges(text);
  return [...findWikiLinks(text, ranges), ...findMarkdownLinks(text)].sort(
    (a, b) => a.start - b.start,
  );
}
