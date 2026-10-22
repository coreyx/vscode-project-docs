/**
 * Redaction: replacing real values from PRIVATE.md with their placeholders in anything Project
 * Docs writes about itself, such as its log (REQ-17.0.4). It's the reverse of decoding, so it has
 * to be cautious rather than exact: it matches case-insensitively, like the standard's commit check,
 * and ignores the boundary rule, so a real value is hidden even inside a longer word.
 */

/** Placeholder -> real value, as read from a PRIVATE.md. */
export type PlaceholderMap = ReadonlyMap<string, string>;

/**
 * Real values shorter than this aren't redacted, matching the standard's commit check: replacing
 * every occurrence of a two-letter value would make messages unreadable.
 */
export const MIN_REDACTED_LENGTH = 4;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Returns a function that replaces every real value in a text with its placeholder. */
export function createRedactor(mapping: PlaceholderMap | null): (text: string) => string {
  if (!mapping || mapping.size === 0) return (text) => text;
  const byReal = new Map<string, string>();
  for (const [placeholder, real] of mapping) {
    if (real.length >= MIN_REDACTED_LENGTH) byReal.set(real.toLowerCase(), placeholder);
  }
  if (byReal.size === 0) return (text) => text;
  // Longest first, so a real value that contains a shorter one is replaced whole.
  const reals = [...byReal.keys()].sort((a, b) => b.length - a.length);
  const pattern = new RegExp(reals.map(escapeRegExp).join("|"), "giu");
  return (text) => text.replace(pattern, (match) => byReal.get(match.toLowerCase()) ?? match);
}
