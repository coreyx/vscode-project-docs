/**
 * Three-way merge of a file changed on both sides since its base (REQ-5.0.1, design.md `merge/`).
 *
 * Merging works on LF-normalized lines (design decision 4), so line endings never cause a conflict;
 * the executor writes the result in each side's own style. The merge is line-based like git's:
 * changes to separate parts of a file combine, identical changes combine, and changes to the same
 * or directly adjacent lines conflict.
 */
import { diff3Merge } from "node-diff3";
import { toLf } from "../scan/index.js";

/** One conflicting region, as lines (without line breaks) from each version. */
export interface ConflictHunk {
  readonly repo: readonly string[];
  readonly base: readonly string[];
  readonly vault: readonly string[];
}

/** The outcome of a merge. */
export type MergeResult =
  | { readonly clean: true; readonly text: string }
  | {
      readonly clean: false;
      readonly hunks: readonly ConflictHunk[];
      /**
       * The merge with each conflict written as standard conflict markers (repo, base, vault),
       * for the conflict-marker fallback when VS Code's merge editor can't be opened
       * (design decision 13).
       */
      readonly markedText: string;
    };

/** Labels used in conflict markers; VS Code shows them in its conflict decorations. */
export const MARKER_LABELS = { repo: "repo", base: "base", vault: "vault" } as const;

// Splitting on "\n" keeps a trailing empty element when the text ends with a line break, so joining
// with "\n" gives back exactly the same text, final line break or not.
function lines(text: string): string[] {
  return toLf(text).split("\n");
}

/** Merges the repo's and the vault's versions against their common base. */
export function mergeText(base: string, repo: string, vault: string): MergeResult {
  const regions = diff3Merge(lines(repo), lines(base), lines(vault));
  const merged: string[] = [];
  const marked: string[] = [];
  const hunks: ConflictHunk[] = [];
  for (const region of regions) {
    if (region.ok) {
      merged.push(...region.ok);
      marked.push(...region.ok);
    } else if (region.conflict) {
      const hunk = { repo: region.conflict.a, base: region.conflict.o, vault: region.conflict.b };
      hunks.push(hunk);
      marked.push(
        `<<<<<<< ${MARKER_LABELS.repo}`,
        ...hunk.repo,
        `||||||| ${MARKER_LABELS.base}`,
        ...hunk.base,
        "=======",
        ...hunk.vault,
        `>>>>>>> ${MARKER_LABELS.vault}`,
      );
    }
  }
  if (hunks.length === 0) return { clean: true, text: merged.join("\n") };
  return { clean: false, hunks, markedText: marked.join("\n") };
}

/** True when text still contains a conflict marker line, so a resolution isn't finished. */
export function hasConflictMarkers(text: string): boolean {
  return /^(<{7}|={7}|>{7}|\|{7})( |$)/m.test(toLf(text));
}
