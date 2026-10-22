/**
 * The PRIVATE.md decoder (REQ-14.0.1): a port of the standard's reference implementation
 * (`skills/private-md/scripts/private_md.py` in private-md-standard). It must decode exactly as the
 * reference does, which the vendored conformance cases and a differential test against the Python
 * script check. Comments note where JavaScript needs something different to behave the same.
 */
import { readFile } from "node:fs/promises";

/** Placeholder -> real value, in the order the rows appear in PRIVATE.md. */
export type PrivateMdMapping = ReadonlyMap<string, string>;

/** The standard's hard errors (§7), plus nothing else: no output may be produced on any of them. */
export type PrivateMdErrorKind = "missing-file" | "no-section" | "no-rows" | "duplicate";

/** A condition the standard treats as a hard error. `kind` is what the conformance cases name. */
export class PrivateMdError extends Error {
  constructor(
    readonly kind: PrivateMdErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "PrivateMdError";
  }
}

export const PLACEHOLDER_HEADING = "## Placeholders";

// Python's str.splitlines() breaks on all of these, not just \n and \r\n, so the port does too.
// eslint-disable-next-line no-control-regex -- the control characters are the point
const LINE_BREAKS = /\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u{2028}\u{2029}]/u;

// Python's re.M `^` matches only at the start or after `\n`; JavaScript's `m` flag also matches
// after a lone `\r`, so the start of a line is spelled out with a lookbehind instead.
const PUBLIC_ONLY_BLOCK =
  /(?<![^\n])<!-- public-only -->\r?\n[\s\S]*?(?<![^\n])<!-- \/public-only -->\r?\n(?:\r?\n)?/g;

// Python's `[^\W_]` (and str.isalnum()): a letter or digit in any script. JavaScript spells it
// with Unicode property escapes.
const ALNUM = "[\\p{L}\\p{N}]";
const IS_ALNUM = /^[\p{L}\p{N}]$/u;

const CODE_SPAN = /^(`+)([\s\S]*?)\1$/;

/**
 * Returns the literal text of a table cell that is exactly one code span, else null. When the
 * content is padded with one space on each side (needed when it starts or ends with a backtick),
 * that one space is stripped, as CommonMark does.
 */
export function parseCodeSpan(cell: string): string | null {
  const match = CODE_SPAN.exec(cell.trim());
  if (!match) return null;
  let text = match[2] ?? "";
  if (text.length >= 2 && text.startsWith(" ") && text.endsWith(" ") && text.trim() !== "") {
    text = text.slice(1, -1);
  }
  return text;
}

/**
 * Reads the placeholder table from PRIVATE.md's text. `source` names the file in error messages.
 * Throws PrivateMdError when the section or its rows are missing or a placeholder is repeated,
 * because a silently partial mapping would leave placeholders in the output.
 */
export function parsePlaceholders(text: string, source = "PRIVATE.md"): Map<string, string> {
  const lines = text.split(LINE_BREAKS);
  // splitlines() drops a final empty element after a trailing break; split() keeps it. It can't
  // match the heading or a row, so it changes nothing.
  const start = lines.indexOf(PLACEHOLDER_HEADING);
  if (start === -1) {
    throw new PrivateMdError("no-section", `${source}: no '${PLACEHOLDER_HEADING}' section`);
  }
  const mapping = new Map<string, string>();
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith("## ")) break;
    if (!line.startsWith("|")) continue;
    // A plain split on '|': the standard forbids a pipe in placeholder and real-value cells.
    const cells = line
      .trim()
      .replace(/^\|+|\|+$/g, "")
      .split("|");
    if (cells.length < 2) continue;
    const placeholder = parseCodeSpan(cells[0] ?? "");
    const real = parseCodeSpan(cells[1] ?? "");
    if (!placeholder || real === null) continue;
    if (mapping.has(placeholder)) {
      throw new PrivateMdError(
        "duplicate",
        `${source}: placeholder ${JSON.stringify(placeholder)} is listed twice`,
      );
    }
    mapping.set(placeholder, real);
  }
  if (mapping.size === 0) {
    throw new PrivateMdError(
      "no-rows",
      `${source}: no placeholder rows under '${PLACEHOLDER_HEADING}'`,
    );
  }
  return mapping;
}

/** Reads and parses a PRIVATE.md file. A missing file is the standard's `missing-file` error. */
export async function loadPlaceholders(file: string): Promise<Map<string, string>> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new PrivateMdError(
        "missing-file",
        `${file} not found: it's gitignored, so restore it from wherever you keep it`,
      );
    }
    throw error;
  }
  return parsePlaceholders(text, file);
}

/** Escapes text for use inside a Unicode-mode regular expression. */
export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

/**
 * Regex source for one placeholder that won't match inside a longer word or number. A boundary is
 * only enforced on an end that is a letter or digit. Ends are taken by code point, as Python's
 * `placeholder[0]` and `placeholder[-1]` are.
 */
export function placeholderPattern(placeholder: string): string {
  const codePoints = [...placeholder];
  let pattern = escapeRegExp(placeholder);
  if (IS_ALNUM.test(codePoints[0] ?? "")) pattern = `(?<!${ALNUM})${pattern}`;
  if (IS_ALNUM.test(codePoints[codePoints.length - 1] ?? "")) pattern += `(?!${ALNUM})`;
  return pattern;
}

/** Placeholders ordered longest first; Python's `len` counts code points, so this does too. */
function longestFirst(values: Iterable<string>): string[] {
  return [...values].sort((a, b) => [...b].length - [...a].length);
}

/**
 * Drops public-only blocks, then replaces every placeholder with its real value in one pass. A
 * single alternation, longest placeholder first, means replaced text is never scanned again.
 */
export function restore(text: string, mapping: PrivateMdMapping): string {
  const withoutPublicOnly = text.replace(PUBLIC_ONLY_BLOCK, "");
  if (mapping.size === 0) return withoutPublicOnly;
  const ordered = longestFirst(mapping.keys());
  const combined = new RegExp(ordered.map((p) => `(${placeholderPattern(p)})`).join("|"), "gu");
  return withoutPublicOnly.replace(combined, (...groups: unknown[]) => {
    // Exactly one capture group matched; its position says which placeholder it was.
    const index = groups.slice(1, ordered.length + 1).findIndex((g) => g !== undefined);
    return mapping.get(ordered[index] ?? "") ?? String(groups[0]);
  });
}
