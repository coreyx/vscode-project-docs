/**
 * Per-file sync rules (REQ-8): the flat `project-docs` frontmatter property, flat so Obsidian's
 * Properties panel can edit it.
 */
import { readProperty, setProperties } from "./frontmatter.js";

/** The frontmatter property that holds a file's sync rule. */
export const RULE_PROPERTY = "project-docs";

/** How a file syncs; `sync` is the default when the property is absent. */
export type SyncRule = "sync" | "repo-to-vault" | "repo-only" | "private";

export const SYNC_RULES: readonly SyncRule[] = ["sync", "repo-to-vault", "repo-only", "private"];

/** A rule that couldn't be understood; the file is not synced (REQ-8.0.2). */
export interface InvalidRule {
  readonly invalid: true;
  /** What was written, for the message in the Project Docs view. */
  readonly value: string;
  readonly message: string;
}

/** Type guard for `InvalidRule`. */
export function isInvalidRule(rule: SyncRule | InvalidRule): rule is InvalidRule {
  return typeof rule === "object";
}

/** Reads a Markdown file's sync rule. */
export function readRule(markdown: string): SyncRule | InvalidRule {
  const property = readProperty(markdown, RULE_PROPERTY);
  switch (property.kind) {
    case "absent":
      return "sync";
    case "invalid-yaml":
      return {
        invalid: true,
        value: "",
        message: "the frontmatter isn't valid YAML, so the sync rule can't be read",
      };
    case "other":
      return {
        invalid: true,
        value: "",
        message: `${RULE_PROPERTY} must be one of ${SYNC_RULES.join(", ")}`,
      };
    case "scalar": {
      const value = property.value === null ? "" : String(property.value);
      if ((SYNC_RULES as readonly string[]).includes(value)) return value as SyncRule;
      return {
        invalid: true,
        value,
        message: `${RULE_PROPERTY}: "${value}" isn't a sync rule; use one of ${SYNC_RULES.join(", ")}`,
      };
    }
  }
}

/** Sets a Markdown file's sync rule, changing only that property's line (REQ-9.2). */
export function setRule(markdown: string, rule: SyncRule): string {
  return setProperties(markdown, { [RULE_PROPERTY]: rule });
}
