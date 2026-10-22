/**
 * How decoded documents are named (design decision 14). Plain functions with no VS Code dependency,
 * so they can be unit-tested.
 */

/** The URI scheme of decoded documents. Virtual documents can't be saved, so it's read-only. */
export const DECODED_SCHEME = "project-docs-decoded";

/** Ends a decoded document's name, so its tab always says what it shows (REQ-14.0.4). */
export const DECODED_SUFFIX = " (Decoded: real values shown)";

/** The status bar's text in each mode (REQ-14.0.4). */
export const MODE_TEXT = {
  decoded: "$(eye) Decoded: real values shown",
  coded: "$(lock) Coded",
} as const;

/** The parts of a decoded document's URI: its path names it, and its query holds the source. */
export interface DecodedUriParts {
  readonly scheme: typeof DECODED_SCHEME;
  readonly path: string;
  readonly query: string;
}

/**
 * The URI parts for the decoded view of a source document. The tab title is the path's last
 * segment, so the suffix goes on the path; the source's full URI rides in the query.
 */
export function decodedUriParts(sourcePath: string, sourceUri: string): DecodedUriParts {
  return { scheme: DECODED_SCHEME, path: `${sourcePath}${DECODED_SUFFIX}`, query: sourceUri };
}
