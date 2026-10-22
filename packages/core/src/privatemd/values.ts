/**
 * Finding and removing real values in text (REQ-13.0.3, REQ-13.0.5).
 *
 * Finding follows the standard's commit check (§8): case-insensitive, real values of 4 or more
 * characters, and results name the placeholder, never the value. Replacing is the fix offered when
 * a change is held back: it swaps each real value for its placeholder, longest first, applying the
 * standard's boundary rule so it never rewrites part of a longer word. An occurrence inside a longer
 * word is still found, but left for the user to edit, since replacing it could corrupt the word.
 */
import { escapeRegExp, type PrivateMdMapping } from "./decode.js";

/** Real values shorter than this are ignored, as in the standard's commit check. */
export const MIN_REAL_VALUE_LENGTH = 4;

/** A real value found in text. Deliberately carries no real value. */
export interface RealValueFinding {
  /** 1-based line number. */
  readonly line: number;
  /** The placeholder whose real value appears on that line. */
  readonly placeholder: string;
}

function checkedValues(mapping: PrivateMdMapping): [real: string, placeholder: string][] {
  return [...mapping]
    .filter(([, real]) => real.length >= MIN_REAL_VALUE_LENGTH)
    .map(([placeholder, real]) => [real, placeholder]);
}

/** Lists every line and placeholder where a real value appears, in any letter case. */
export function findRealValues(text: string, mapping: PrivateMdMapping): RealValueFinding[] {
  const needles = checkedValues(mapping).map(
    ([real, placeholder]) => [real.toLowerCase(), placeholder] as const,
  );
  if (needles.length === 0) return [];
  const findings: RealValueFinding[] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    const lowered = line.toLowerCase();
    for (const [real, placeholder] of needles) {
      if (lowered.includes(real)) findings.push({ line: i + 1, placeholder });
    }
  });
  return findings;
}

/** Where a real value appears in text. Carries the placeholder, never the value. */
export interface RealValueRange {
  /** UTF-16 offsets of the occurrence. */
  readonly start: number;
  readonly end: number;
  readonly placeholder: string;
}

/**
 * Every occurrence of a real value, in any letter case, as offsets: what an editor needs to mark
 * the text without the result ever holding the value itself. Longer values win where they overlap.
 */
export function findRealValueRanges(text: string, mapping: PrivateMdMapping): RealValueRange[] {
  const values = checkedValues(mapping).sort(([a], [b]) => b.length - a.length);
  if (values.length === 0) return [];
  const byLower = new Map(values.map(([real, placeholder]) => [real.toLowerCase(), placeholder]));
  const pattern = new RegExp(values.map(([real]) => escapeRegExp(real)).join("|"), "giu");
  const ranges: RealValueRange[] = [];
  for (const match of text.matchAll(pattern)) {
    const placeholder = byLower.get(match[0].toLowerCase());
    if (placeholder !== undefined) {
      ranges.push({ start: match.index, end: match.index + match[0].length, placeholder });
    }
  }
  return ranges;
}

const ALNUM = "[\\p{L}\\p{N}]";
const IS_ALNUM = /^[\p{L}\p{N}]$/u;

/**
 * Replaces each real value, in any letter case, with its placeholder: longest real value first,
 * in one pass, with the boundary rule on ends that are letters or digits.
 */
export function replaceRealValues(text: string, mapping: PrivateMdMapping): string {
  const values = checkedValues(mapping).sort(([a], [b]) => [...b].length - [...a].length);
  if (values.length === 0) return text;
  const byLower = new Map(values.map(([real, placeholder]) => [real.toLowerCase(), placeholder]));
  const source = values
    .map(([real]) => {
      const points = [...real];
      let pattern = escapeRegExp(real);
      if (IS_ALNUM.test(points[0] ?? "")) pattern = `(?<!${ALNUM})${pattern}`;
      if (IS_ALNUM.test(points[points.length - 1] ?? "")) pattern += `(?!${ALNUM})`;
      return pattern;
    })
    .join("|");
  return text.replace(
    new RegExp(source, "giu"),
    (match) => byLower.get(match.toLowerCase()) ?? match,
  );
}
