/**
 * Validation of the link records. The committed record is held to a stricter rule than its shape:
 * it must not contain an absolute path anywhere, because it's published with the repo (REQ-2.1).
 */
import {
  DEFAULT_SETTINGS,
  RECORD_FORMAT,
  type CommittedLink,
  type LinkSettingsRecord,
  type LocalLink,
} from "./types.js";

/** Matches the project ids Project Docs creates (`pd_` and a UUID). */
export const PROJECT_ID_PATTERN =
  /^pd_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** True for a path that's absolute on any platform this runs on, or that climbs out of its root. */
export function isUnsafeRelativePath(value: string): boolean {
  const unified = value.replace(/\\/g, "/");
  return (
    unified.startsWith("/") ||
    /^[A-Za-z]:/.test(unified) ||
    unified.startsWith("//") ||
    unified.split("/").includes("..") ||
    unified.startsWith("~")
  );
}

/** Finds strings anywhere in a value that look like absolute paths. */
function absolutePathsIn(value: unknown, at = "$"): string[] {
  if (typeof value === "string") {
    if (value.startsWith("obsidian://")) return [];
    return /(^|[\s"'(])([A-Za-z]:[\\/]|\\\\|\/(home|Users|mnt|root|var|tmp)\/)/.test(value)
      ? [at]
      : [];
  }
  if (Array.isArray(value)) return value.flatMap((v, i) => absolutePathsIn(v, `${at}[${i}]`));
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([k, v]) => absolutePathsIn(v, `${at}.${k}`));
  }
  return [];
}

function settingsFrom(value: unknown, problems: string[]): LinkSettingsRecord {
  const input = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const settings: Record<string, unknown> = { ...DEFAULT_SETTINGS };
  for (const [name, fallback] of Object.entries(DEFAULT_SETTINGS)) {
    const given = input[name];
    if (given === undefined) continue;
    if (typeof given !== typeof fallback) {
      problems.push(`settings.${name} must be a ${typeof fallback}`);
      continue;
    }
    settings[name] = given;
  }
  const result = settings as unknown as LinkSettingsRecord;
  if (isUnsafeRelativePath(result.privateSubfolder) || result.privateSubfolder.includes("/")) {
    problems.push("settings.privateSubfolder must be a single folder name");
  }
  if (!result.folderNotePattern.endsWith(".md")) {
    problems.push("settings.folderNotePattern must name a Markdown file");
  }
  return result;
}

/** Validates the committed record, returning it or the problems found. */
export function validateCommitted(value: unknown): CommittedLink | { problems: string[] } {
  const problems: string[] = [];
  const input = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  if (input["format"] !== RECORD_FORMAT) problems.push(`format must be ${RECORD_FORMAT}`);
  const projectId = input["projectId"];
  if (typeof projectId !== "string" || !PROJECT_ID_PATTERN.test(projectId)) {
    problems.push("projectId must be a Project Docs id (pd_ followed by a UUID)");
  }
  for (const field of ["docsFolder", "vaultFolder"] as const) {
    const folder = input[field];
    if (typeof folder !== "string") problems.push(`${field} must be a string`);
    else if (isUnsafeRelativePath(folder))
      problems.push(`${field} must be a relative path inside its root`);
  }
  const settings = settingsFrom(input["settings"], problems);
  const deepLink = input["deepLink"];
  if (
    deepLink !== undefined &&
    (typeof deepLink !== "string" || !deepLink.startsWith("obsidian://adv-uri?uid="))
  ) {
    problems.push("deepLink must be an obsidian://adv-uri?uid= link");
  }
  for (const where of absolutePathsIn(input)) problems.push(`${where} contains an absolute path`);
  if (problems.length > 0) return { problems };
  return {
    format: RECORD_FORMAT,
    description: typeof input["description"] === "string" ? input["description"] : "",
    projectId: projectId as string,
    docsFolder: (input["docsFolder"] as string).replace(/\\/g, "/"),
    vaultFolder: (input["vaultFolder"] as string).replace(/\\/g, "/"),
    settings,
    ...(typeof deepLink === "string" ? { deepLink } : {}),
  };
}

/** Validates the machine-local record. */
export function validateLocal(value: unknown): LocalLink | { problems: string[] } {
  const problems: string[] = [];
  const input = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  if (input["format"] !== RECORD_FORMAT) problems.push(`format must be ${RECORD_FORMAT}`);
  for (const field of ["projectId", "vaultRoot", "vaultFolderPath", "linkNotePath"] as const) {
    if (typeof input[field] !== "string" || input[field] === "")
      problems.push(`${field} must be set`);
  }
  if (problems.length > 0) return { problems };
  return input as unknown as LocalLink;
}

/**
 * A JSON schema for `.project-docs.json`, which the extension contributes to VS Code so editing the
 * file by hand gets completion and checking.
 */
export const COMMITTED_SCHEMA = {
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "Project Docs link",
  type: "object",
  required: ["format", "projectId", "docsFolder", "vaultFolder"],
  properties: {
    format: { const: RECORD_FORMAT },
    description: { type: "string" },
    projectId: { type: "string", pattern: PROJECT_ID_PATTERN.source },
    docsFolder: { type: "string", description: "The docs folder, relative to the repo root." },
    vaultFolder: { type: "string", description: "The linked folder, relative to the vault root." },
    deepLink: {
      type: "string",
      pattern: "^obsidian://adv-uri\\?uid=",
      description:
        "Opens the project's folder note through the Advanced URI plugin. Written by Project Docs while advancedUriDeepLinks is on.",
    },
    settings: {
      type: "object",
      properties: {
        privateSubfolder: {
          type: "string",
          default: DEFAULT_SETTINGS.privateSubfolder,
          description: "The vault subfolder whose notes never sync to the repo.",
        },
        folderNotePattern: {
          type: "string",
          default: DEFAULT_SETTINGS.folderNotePattern,
          description: "Where the link note goes in the vault: the project folder's folder note.",
        },
        syncAttachments: {
          type: "boolean",
          default: false,
          description: "Also sync files other than Markdown, such as images.",
        },
        keepLinksAsWritten: {
          type: "boolean",
          default: false,
          description:
            "Leave Obsidian wikilinks as written instead of converting them to Markdown links.",
        },
        allowLinksOutsideProjectFolder: {
          type: "boolean",
          default: false,
          description: "Let synced notes link to vault notes outside the project folder.",
        },
        advancedUriDeepLinks: {
          type: "boolean",
          default: false,
          description:
            "Open the project in Obsidian through the Advanced URI plugin. Project Docs puts `uid: <project id>` in the project folder's folder note, which anchors the link to the folder however its contents change; if you add the uid by hand, put it there too.",
        },
      },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
} as const;
