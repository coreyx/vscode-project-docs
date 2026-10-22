/**
 * What VS Code offers when changing a file's sync rule (REQ-9), and which files it applies to.
 * Plain functions with no VS Code dependency, so they can be unit-tested.
 */
import * as path from "node:path";
import { isInvalidRule, type InvalidRule, type SyncRule } from "@specdevship/project-docs-core";

/** One rule as offered in the context menu and the picker. */
export interface RuleChoice {
  readonly rule: SyncRule;
  /** The command that sets this rule from the Explorer's context menu. */
  readonly command: string;
  readonly label: string;
  readonly detail: string;
}

/**
 * The rules VS Code offers. `private` isn't among them: private notes live in the vault, and a repo
 * file marked private would be one the repo already holds (REQ-9.0.2).
 */
export const RULE_CHOICES: readonly RuleChoice[] = [
  {
    rule: "sync",
    command: "projectDocs.setRule.sync",
    label: "sync",
    detail: "Edits in either app are copied to the other.",
  },
  {
    rule: "repo-to-vault",
    command: "projectDocs.setRule.repoToVault",
    label: "repo-to-vault",
    detail: "The repo's copy wins; edits made in Obsidian are reported, not copied back.",
  },
  {
    rule: "repo-only",
    command: "projectDocs.setRule.repoOnly",
    label: "repo-only",
    detail: "Never copied to the vault.",
  },
];

/**
 * The key of a Markdown file inside the docs folder, or null for any other file: rules only apply
 * to synced Markdown files.
 */
export function ruleKey(file: string, docsRoot: string, pathApi = path): string | null {
  if (pathApi.extname(file).toLowerCase() !== ".md") return null;
  const relative = pathApi.relative(docsRoot, file);
  if (relative === "" || relative.startsWith("..") || pathApi.isAbsolute(relative)) return null;
  return relative.split(pathApi.sep).join("/");
}

/** The status bar's text for the current file's rule (REQ-9.0.1). */
export function ruleStatusText(rule: SyncRule | InvalidRule): { text: string; tooltip: string } {
  if (isInvalidRule(rule)) {
    return { text: "$(warning) invalid rule", tooltip: `Project Docs: ${rule.message}` };
  }
  const icon: Record<SyncRule, string> = {
    sync: "$(arrow-swap)",
    "repo-to-vault": "$(arrow-right)",
    "repo-only": "$(circle-slash)",
    private: "$(lock)",
  };
  return {
    text: `${icon[rule]} ${rule}`,
    tooltip: `Project Docs sync rule: ${rule}. Click to change it.`,
  };
}

/**
 * The smallest edit that turns `before` into `after`: the differing middle, after their common
 * prefix and suffix. Applying only this keeps the cursor and the undo history of an open editor.
 */
export function minimalEdit(
  before: string,
  after: string,
): { start: number; end: number; text: string } {
  let start = 0;
  const shorter = Math.min(before.length, after.length);
  while (start < shorter && before[start] === after[start]) start++;
  let suffix = 0;
  while (
    suffix < shorter - start &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix++;
  }
  return {
    start,
    end: before.length - suffix,
    text: after.slice(start, after.length - suffix),
  };
}
