/** Converting text offsets to editor positions, without VS Code, so it can be unit-tested. */

/** A zero-based line and character, as VS Code counts them. */
export interface TextPosition {
  readonly line: number;
  readonly character: number;
}

/**
 * The line and character of a UTF-16 offset. Lines end at `\n`; in CRLF text the `\r` stays at the
 * end of its line, which is how VS Code counts it too.
 */
export function offsetToPosition(text: string, offset: number): TextPosition {
  let line = 0;
  let lineStart = 0;
  for (let i = text.indexOf("\n"); i !== -1 && i < offset; i = text.indexOf("\n", i + 1)) {
    line++;
    lineStart = i + 1;
  }
  return { line, character: offset - lineStart };
}
