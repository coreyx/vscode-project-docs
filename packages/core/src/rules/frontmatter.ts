/**
 * Frontmatter access that never reformats a file (REQ-9.2).
 *
 * Re-serializing YAML can re-quote, re-wrap or reorder other properties, so edits here are
 * positional: the `yaml` library parses the block only to find where a top-level property's line
 * starts and its value ends, and that span is spliced out and replaced. Every other byte of the
 * file, including comments and line endings, is copied through unchanged.
 */
import { isMap, isScalar, parseDocument, type Node, type Pair } from "yaml";

/** Where a file's frontmatter block is, in UTF-16 offsets into the file's text. */
export interface FrontmatterBlock {
  /** Offset of the first character of the YAML, just after the opening `---` line. */
  readonly yamlStart: number;
  /** Offset just past the YAML, where the closing `---` line begins. */
  readonly yamlEnd: number;
  readonly yaml: string;
  /** The line break the file uses, for any line that has to be inserted. */
  readonly eol: "\n" | "\r\n";
}

const BOM = "﻿";

/**
 * Finds the frontmatter block, following Obsidian's rule: the file's very first line is `---`, and
 * the block ends at the next line that is exactly `---`. Returns null when there is none.
 */
export function findFrontmatter(text: string): FrontmatterBlock | null {
  const offset = text.startsWith(BOM) ? 1 : 0;
  const open = /^---[ \t]*(\r?\n)/.exec(text.slice(offset));
  if (!open?.[1]) return null;
  const eol = open[1] as "\n" | "\r\n";
  const yamlStart = offset + open[0].length;
  // `$` in multiline mode also stops before `\r`, so a CRLF file's closing line matches too.
  const match = /^---[ \t]*$/m.exec(text.slice(yamlStart));
  if (!match) return null;
  const yamlEnd = yamlStart + match.index;
  return { yamlStart, yamlEnd, yaml: text.slice(yamlStart, yamlEnd), eol };
}

/** A property's value as read from frontmatter. */
export type PropertyValue =
  | { readonly kind: "absent" }
  | { readonly kind: "scalar"; readonly value: string | number | boolean | null }
  | { readonly kind: "other" }
  | { readonly kind: "invalid-yaml" };

function topLevelPair(
  yaml: string,
  name: string,
): { pair: Pair<Node, Node | null> | null; ok: boolean } {
  const doc = parseDocument(yaml, { keepSourceTokens: false });
  if (doc.errors.length > 0) return { pair: null, ok: false };
  if (doc.contents === null) return { pair: null, ok: true };
  if (!isMap(doc.contents)) return { pair: null, ok: false };
  for (const item of doc.contents.items as Pair<Node, Node | null>[]) {
    if (isScalar(item.key) && item.key.value === name) return { pair: item, ok: true };
  }
  return { pair: null, ok: true };
}

/** Reads a top-level frontmatter property. */
export function readProperty(text: string, name: string): PropertyValue {
  const block = findFrontmatter(text);
  if (!block) return { kind: "absent" };
  const { pair, ok } = topLevelPair(block.yaml, name);
  if (!ok) return { kind: "invalid-yaml" };
  if (!pair) return { kind: "absent" };
  if (pair.value === null || pair.value === undefined) return { kind: "scalar", value: null };
  if (isScalar(pair.value)) {
    const value = pair.value.value;
    if (value === null || ["string", "number", "boolean"].includes(typeof value)) {
      return { kind: "scalar", value: value as string | number | boolean | null };
    }
  }
  return { kind: "other" };
}

// Values that YAML would read as something other than the same string if written unquoted.
const PLAIN_SAFE = /^[A-Za-z_][A-Za-z0-9_.\-/]*$/;
const RESERVED_WORDS = /^(true|false|yes|no|on|off|null|~)$/i;

/** Writes a string as a YAML scalar: plain when that reads back identically, else single-quoted. */
export function yamlScalar(value: string): string {
  if (PLAIN_SAFE.test(value) && !RESERVED_WORDS.test(value)) return value;
  // Single quotes take everything literally (backslashes in Windows paths included); a single
  // quote is written twice.
  return `'${value.replace(/'/g, "''")}'`;
}

/** Thrown when frontmatter exists but can't be edited safely. */
export class FrontmatterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FrontmatterError";
  }
}

/**
 * Sets top-level properties, changing only their own lines. Existing properties are replaced in
 * place; new ones are appended at the end of the block; a file with no frontmatter gets a block.
 * Values are written as YAML scalars.
 */
export function setProperties(text: string, properties: Readonly<Record<string, string>>): string {
  const names = Object.keys(properties);
  if (names.length === 0) return text;
  const block = findFrontmatter(text);
  if (!block) {
    const eol = text.includes("\r\n") ? "\r\n" : "\n";
    const offset = text.startsWith(BOM) ? 1 : 0;
    const lines = names.map((name) => `${name}: ${yamlScalar(properties[name] ?? "")}`);
    return `${text.slice(0, offset)}---${eol}${lines.join(eol)}${eol}---${eol}${text.slice(offset)}`;
  }

  let yaml = block.yaml;
  const appended: string[] = [];
  for (const name of names) {
    const line = `${name}: ${yamlScalar(properties[name] ?? "")}`;
    const span = propertySpan(yaml, name);
    if (!span) {
      appended.push(line);
      continue;
    }
    yaml = yaml.slice(0, span.lineStart) + line + yaml.slice(span.lineEnd);
  }
  if (appended.length > 0) {
    const needsBreak = yaml.length > 0 && !yaml.endsWith("\n");
    yaml += (needsBreak ? block.eol : "") + appended.join(block.eol) + block.eol;
  }
  return text.slice(0, block.yamlStart) + yaml + text.slice(block.yamlEnd);
}

/**
 * Where a top-level property sits in a YAML block: from the start of its key's line to the end of
 * its value's last line, not including the line break. Null when the property isn't there.
 */
function propertySpan(yaml: string, name: string): { lineStart: number; lineEnd: number } | null {
  const { pair, ok } = topLevelPair(yaml, name);
  if (!ok)
    throw new FrontmatterError("the frontmatter isn't valid YAML, so it can't be edited safely");
  if (!pair) return null;
  const keyRange = (pair.key as Node).range;
  if (!keyRange) throw new FrontmatterError(`can't locate ${name} in the frontmatter`);
  const valueEnd = pair.value?.range?.[1] ?? keyRange[1];
  const lineStart = yaml.lastIndexOf("\n", keyRange[0] - 1) + 1;
  const nextBreak = yaml.indexOf("\n", Math.max(valueEnd - 1, keyRange[1]));
  const lineEnd =
    nextBreak === -1 ? yaml.length : yaml[nextBreak - 1] === "\r" ? nextBreak - 1 : nextBreak;
  return { lineStart, lineEnd };
}

/**
 * Removes top-level properties and their lines, leaving everything else byte-identical. Used when
 * unlinking, to take the link properties back out of the link note (REQ-1.0.5).
 */
export function removeProperties(text: string, names: readonly string[]): string {
  const block = findFrontmatter(text);
  if (!block) return text;
  let yaml = block.yaml;
  for (const name of names) {
    const span = propertySpan(yaml, name);
    if (!span) continue;
    // Take the line break after the property too, so no blank line is left behind.
    const after = yaml.startsWith("\r\n", span.lineEnd)
      ? 2
      : yaml.startsWith("\n", span.lineEnd)
        ? 1
        : 0;
    yaml = yaml.slice(0, span.lineStart) + yaml.slice(span.lineEnd + after);
  }
  return text.slice(0, block.yamlStart) + yaml + text.slice(block.yamlEnd);
}
