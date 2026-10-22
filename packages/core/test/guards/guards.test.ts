import { describe, expect, it } from "vitest";
import {
  EMPTY_PRIVATE_FILES,
  INVALID_PRIVATE_FILES,
  checkVaultChange,
  inPrivateSubfolder,
  parsePrivateFilesList,
  type GuardContext,
  type VaultChange,
} from "../../src/guards/index.js";
import { createResolver } from "../../src/links/index.js";
import { markdownHash, sha256 } from "../../src/scan/index.js";

const resolver = createResolver({
  projectFolder: "Projects/repo",
  files: [
    "Projects/repo/guide.md",
    "Projects/repo/private/server-notes.md",
    "Projects/repo/marked.md",
    "Projects/repo/shot.png",
    "Journal/today.md",
  ],
});

function context(overrides: Partial<GuardContext> = {}): GuardContext {
  return {
    privateSubfolder: "private",
    linkNoteKey: "repo.md",
    privateFiles: EMPTY_PRIVATE_FILES,
    allowLinksOutside: false,
    mapping: new Map([
      ["myhost", "DESK-FAKE01"],
      ["ab", "xy"],
    ]),
    resolver,
    isPrivateNote: (key) => key === "marked.md",
    ...overrides,
  };
}

const note = (key: string, text: string): VaultChange => ({
  key,
  kind: "markdown",
  hash: markdownHash(text),
  text,
});
const attachment = (key: string, bytes: string): VaultChange => ({
  key,
  kind: "attachment",
  hash: sha256(bytes),
});

describe("vault-only files never reach the repo", () => {
  it("allows an ordinary note", () => {
    expect(checkVaultChange(note("guide.md", "# Guide\n[[guide]]\n"), context())).toEqual({
      action: "allow",
    });
  });

  it("keeps anything in the private folder vault-only, whatever its frontmatter (REQ-10.2, 10.3)", () => {
    const verdict = checkVaultChange(
      note("private/plan.md", "---\nproject-docs: sync\n---\n"),
      context(),
    );
    expect(verdict.action).toBe("vaultOnly");
    expect(verdict.action !== "allow" && verdict.reasons.map((r) => r.code)).toEqual([
      "private-folder",
    ]);
  });

  it("keeps a note marked private vault-only wherever it is (REQ-10.1, 10.2)", () => {
    const verdict = checkVaultChange(
      note("moved-out.md", "---\nproject-docs: private\n---\nx"),
      context(),
    );
    expect(verdict.action !== "allow" && verdict.reasons.map((r) => r.code)).toEqual([
      "private-marker",
    ]);
  });

  it("keeps the link note vault-only, even when marked sync (REQ-2.9)", () => {
    const verdict = checkVaultChange(note("repo.md", "---\nproject-docs: sync\n---\n"), context());
    expect(verdict.action !== "allow" && verdict.reasons.map((r) => r.code)).toEqual(["link-note"]);
  });

  it("keeps never-synced names vault-only (REQ-3.4)", () => {
    for (const key of ["PRIVATE.md", "PRIVATE.example.md", "notes.private.md"]) {
      expect(checkVaultChange(note(key, "x"), context()).action).toBe("vaultOnly");
    }
  });

  it("is quiet about the private folder only when one is configured", () => {
    expect(inPrivateSubfolder("private/a.md", "private")).toBe(true);
    expect(inPrivateSubfolder("private", "private")).toBe(true);
    expect(inPrivateSubfolder("privateer.md", "private")).toBe(false);
    expect(inPrivateSubfolder("a.md", "")).toBe(false);
  });
});

describe("private attachments (REQ-11.3)", () => {
  const list = parsePrivateFilesList(
    JSON.stringify({ format: 1, files: [{ path: "private/shot.png", sha256: sha256("pixels") }] }),
  );

  it("keeps an attachment on the list vault-only by path", () => {
    expect(
      checkVaultChange(attachment("private/shot.png", "pixels"), context({ privateFiles: list }))
        .action,
    ).toBe("vaultOnly");
  });

  it("keeps it vault-only by hash after it's moved, renamed or duplicated outside the folder", () => {
    for (const key of ["shot.png", "renamed.png", "copies/shot (2).png"]) {
      const verdict = checkVaultChange(attachment(key, "pixels"), context({ privateFiles: list }));
      expect(verdict.action !== "allow" && verdict.reasons.map((r) => r.code)).toEqual([
        "private-list",
      ]);
    }
  });

  it("allows an attachment that isn't on the list", () => {
    expect(
      checkVaultChange(attachment("diagram.png", "other"), context({ privateFiles: list })),
    ).toEqual({ action: "allow" });
  });

  it("holds back every attachment while the list can't be read", () => {
    const verdict = checkVaultChange(
      attachment("diagram.png", "other"),
      context({ privateFiles: INVALID_PRIVATE_FILES }),
    );
    expect(verdict.action).toBe("holdBack");
  });

  it("parses the list defensively", () => {
    expect(parsePrivateFilesList(null)).toBe(EMPTY_PRIVATE_FILES);
    expect(parsePrivateFilesList("{ nope")).toBe(INVALID_PRIVATE_FILES);
    expect(parsePrivateFilesList("{}")).toBe(INVALID_PRIVATE_FILES);
    expect(parsePrivateFilesList('{"files":[{"path":1}]}')).toBe(INVALID_PRIVATE_FILES);
    expect(parsePrivateFilesList('{"files":[null]}')).toBe(INVALID_PRIVATE_FILES);
  });
});

describe("changes held back from the repo (REQ-13)", () => {
  it("holds back a link to a private note, naming the link (REQ-13.1)", () => {
    const verdict = checkVaultChange(
      note("guide.md", "See [[private/server-notes]].\n"),
      context(),
    );
    expect(verdict).toMatchObject({
      action: "holdBack",
      reasons: [{ code: "links-private", link: "[[private/server-notes]]" }],
    });
  });

  it("holds back a link to a note marked private outside the folder", () => {
    expect(checkVaultChange(note("guide.md", "[x](marked.md)"), context())).toMatchObject({
      action: "holdBack",
      reasons: [{ code: "links-private" }],
    });
  });

  it("holds back a link to a private-listed attachment", () => {
    const list = parsePrivateFilesList(
      JSON.stringify({ files: [{ path: "shot.png", sha256: sha256("p") }] }),
    );
    expect(
      checkVaultChange(note("guide.md", "![[shot.png]]"), context({ privateFiles: list })).action,
    ).toBe("holdBack");
  });

  it("holds back a link outside the project folder unless allowed (REQ-13.2)", () => {
    const change = note("guide.md", "See [[today]].\n");
    expect(checkVaultChange(change, context())).toMatchObject({
      action: "holdBack",
      reasons: [{ code: "links-outside", link: "[[today]]" }],
    });
    expect(checkVaultChange(change, context({ allowLinksOutside: true }))).toEqual({
      action: "allow",
    });
  });

  it("holds back a real value, naming only the placeholder (REQ-13.3)", () => {
    const verdict = checkVaultChange(
      note("guide.md", "ssh desk-fake01\nssh DESK-FAKE01\n"),
      context(),
    );
    expect(verdict).toMatchObject({
      action: "holdBack",
      reasons: [{ code: "real-value", placeholder: "myhost" }],
    });
    expect(JSON.stringify(verdict).toLowerCase()).not.toContain("desk-fake01");
  });

  it("allows real-value-free text when there's no PRIVATE.md", () => {
    expect(
      checkVaultChange(note("guide.md", "ssh DESK-FAKE01"), context({ mapping: null })),
    ).toEqual({
      action: "allow",
    });
  });

  it("collects every reason at once", () => {
    const verdict = checkVaultChange(
      note("guide.md", "[[private/server-notes]] [[today]] DESK-FAKE01"),
      context(),
    );
    expect(verdict.action !== "allow" && verdict.reasons.map((r) => r.code)).toEqual([
      "links-private",
      "links-outside",
      "real-value",
    ]);
  });

  it("allows a missing link target, which names nothing that exists", () => {
    expect(checkVaultChange(note("guide.md", "[[Future note]]"), context())).toEqual({
      action: "allow",
    });
  });

  it("allows an attachment change that carries no text", () => {
    expect(checkVaultChange({ key: "guide.md", kind: "markdown", hash: "h" }, context())).toEqual({
      action: "allow",
    });
  });
});
