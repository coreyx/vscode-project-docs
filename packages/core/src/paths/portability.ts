/**
 * Portability checks: whether a key can be written on the receiving side's filesystem
 * (REQ-16.0.2). Only Windows filesystems (including a Windows drive seen from WSL) restrict names
 * beyond `/` and NUL, so a non-Windows target only rejects NUL.
 */

/** Why a key can't be written on the target side. */
export interface PortabilityProblem {
  /** The path segment at fault. */
  readonly segment: string;
  readonly reason: "reserved-name" | "forbidden-character" | "trailing-dot-or-space" | "nul";
  /** A short explanation for the Project Docs view. */
  readonly message: string;
}

// Windows reserves these device names in every folder, with or without an extension (`con.md`
// is as unusable as `CON`).
const RESERVED = /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(\..*)?$/i;
// Characters Windows refuses in names; control characters 1–31 are refused too.
// eslint-disable-next-line no-control-regex
const FORBIDDEN = /[<>:"\\|?*\u0001-\u001f]/;

/**
 * Returns the first problem that stops `key` being written on the target, or null if it can be.
 * `windowsTarget` is the receiving side's `isWindowsFs`.
 */
export function checkPortable(key: string, windowsTarget: boolean): PortabilityProblem | null {
  for (const segment of key.split("/")) {
    if (segment.includes("\u0000")) {
      return { segment, reason: "nul", message: `"${segment}" contains a NUL character` };
    }
    if (!windowsTarget) continue;
    if (RESERVED.test(segment)) {
      return {
        segment,
        reason: "reserved-name",
        message: `"${segment}" is a reserved device name on Windows`,
      };
    }
    const forbidden = FORBIDDEN.exec(segment);
    if (forbidden) {
      const shown = forbidden[0] < " " ? "a control character" : `"${forbidden[0]}"`;
      return {
        segment,
        reason: "forbidden-character",
        message: `"${segment}" contains ${shown}, which Windows doesn't allow in file names`,
      };
    }
    if (/[. ]$/.test(segment)) {
      return {
        segment,
        reason: "trailing-dot-or-space",
        message: `"${segment}" ends with a dot or a space, which Windows removes`,
      };
    }
  }
  return null;
}
