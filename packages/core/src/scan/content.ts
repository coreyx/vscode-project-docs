/**
 * Content helpers shared by the scanner, the merge and the executor: hashing, strict UTF-8
 * decoding, and line-ending detection and conversion (design decision 4).
 */
import { createHash } from "node:crypto";

/** A side's line-ending style for one file. `none` means the file has no line breaks. */
export type LineEnding = "lf" | "crlf" | "none";

const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** Decodes UTF-8, returning null for bytes that aren't valid UTF-8 (REQ-16.0.4). */
export function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return strictUtf8.decode(bytes);
  } catch {
    return null;
  }
}

/** Converts every CRLF to LF, so the two sides' copies compare equal regardless of line endings. */
export function toLf(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

/**
 * Detects a file's line-ending style. A file mixing both is recorded by its majority, so writing
 * it back changes as few lines as possible.
 */
export function detectLineEnding(text: string): LineEnding {
  const crlf = text.match(/\r\n/g)?.length ?? 0;
  const lf = (text.match(/\n/g)?.length ?? 0) - crlf;
  if (crlf === 0 && lf === 0) return "none";
  return crlf > lf ? "crlf" : "lf";
}

/** Converts LF text to the given style for writing to a side. `none` leaves it as LF. */
export function applyLineEnding(lfText: string, ending: LineEnding): string {
  return ending === "crlf" ? lfText.replace(/\n/g, "\r\n") : lfText;
}

/** SHA-256 of some bytes, as lowercase hex. */
export function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** The hash used for Markdown: SHA-256 of the LF-normalized text, so line endings don't count. */
export function markdownHash(text: string): string {
  return sha256(toLf(text));
}
