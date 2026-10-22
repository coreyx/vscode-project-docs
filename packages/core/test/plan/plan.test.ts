import { describe, expect, it } from "vitest";
import { parsePrivateFilesList } from "../../src/guards/index.js";
import { plan, type Action } from "../../src/plan/index.js";
import { markdownHash, sha256 } from "../../src/scan/index.js";
import { agree, hashOf, input, synced, world } from "./world.js";

const summary = (actions: readonly Action[]) =>
  actions.map((a) => {
    switch (a.type) {
      case "copy":
        return `copy ${a.from}->${a.from === "repo" ? "vault" : "repo"} ${a.key}`;
      case "writeBoth":
        return `writeBoth ${a.key}`;
      case "rename":
        return `rename ${a.side} ${a.from}->${a.to}`;
      case "trash":
        return `trash ${a.side} ${a.key}`;
      case "conflict":
        return `conflict ${a.key}`;
      case "adopt":
        return `adopt ${a.key}`;
      case "record":
        return `record ${a.key} ${a.update.entry?.state ?? "forget"}`;
    }
  });

describe("first sync (REQ-1.0.3)", () => {
  it("copies files that exist on one side, adopts identical ones, and keeps the repo's version on a clash", async () => {
    const w = world({
      repo: { "only-repo.md": "r\n", "same.md": "same\n", "differ.md": "repo version\n" },
      vault: { "only-vault.md": "v\n", "same.md": "same\n", "differ.md": "vault version\n" },
    });
    const result = await plan(input(w));
    expect(summary(result.actions)).toEqual([
      "conflict differ.md",
      "copy repo->vault only-repo.md",
      "copy vault->repo only-vault.md",
      "adopt same.md",
    ]);
    expect(result.notices.map((n) => n.code)).toEqual(["conflict"]);
    const conflict = result.actions.find((a) => a.type === "conflict");
    expect(conflict).toMatchObject({
      repoHash: markdownHash("repo version\n"),
      vaultHash: markdownHash("vault version\n"),
      baseHash: null,
    });
  });

  it("treats a file whose only difference was wikilinks as agreed, writing the converted text", async () => {
    const w = world({
      repo: { "a.md": "See [b](b.md).\n", "b.md": "b\n" },
      vault: { "a.md": "See [[b]].\n", "b.md": "b\n" },
    });
    expect(summary((await plan(input(w))).actions)).toEqual(["writeBoth a.md", "adopt b.md"]);
  });
});

describe("one side changed", () => {
  it("copies changes in each direction (REQ-4.1)", async () => {
    const w = world();
    synced(w, "a.md", "a\n");
    synced(w, "b.md", "b\n");
    w.repo["a.md"] = "a edited in VS Code\n";
    w.vault["b.md"] = "b edited in Obsidian\n";
    const result = await plan(input(w));
    expect(summary(result.actions)).toEqual(["copy repo->vault a.md", "copy vault->repo b.md"]);
    const copy = result.actions[0];
    expect(copy?.type === "copy" && copy.update.entry?.baseHash).toBe(
      markdownHash("a edited in VS Code\n"),
    );
  });

  it("does nothing when nothing changed", async () => {
    const w = world();
    synced(w, "a.md", "a\n");
    expect((await plan(input(w))).actions).toEqual([]);
  });

  it("keeps each side's line endings when copying (REQ-3.2)", async () => {
    const w = world();
    w.repo["a.md"] = "one\r\ntwo\r\n";
    w.vault["a.md"] = "one\ntwo\n";
    agree(w, "a.md", "one\ntwo\n", { repoLineEnding: "crlf", vaultLineEnding: "lf" });
    w.repo["a.md"] = "one\r\nTWO\r\n";
    const [copy] = (await plan(input(w))).actions;
    expect(copy).toMatchObject({ type: "copy", targetLineEnding: "lf" });
    expect(copy?.update.entry).toMatchObject({ repoLineEnding: "crlf", vaultLineEnding: "lf" });
  });

  it("uses the target's default line ending for new files", async () => {
    const w = world({
      repo: { "a.md": "x\ny\n" },
      vaultTraits: { isWindowsFs: true, caseInsensitive: true },
    });
    expect((await plan(input(w))).actions[0]).toMatchObject({ targetLineEnding: "crlf" });
  });
});

describe("both sides changed (REQ-5)", () => {
  it("merges edits to different paragraphs (REQ-5.1)", async () => {
    const w = world();
    synced(w, "a.md", "one\n\ntwo\n\nthree\n\nfour\n\nfive\n");
    w.repo["a.md"] = "ONE\n\ntwo\n\nthree\n\nfour\n\nfive\n";
    w.vault["a.md"] = "one\n\ntwo\n\nthree\n\nfour\n\nFIVE\n";
    const [action] = (await plan(input(w))).actions;
    expect(action).toMatchObject({
      type: "writeBoth",
      text: "ONE\n\ntwo\n\nthree\n\nfour\n\nFIVE\n",
      expectRepoHash: markdownHash(w.repo["a.md"] ?? ""),
      expectVaultHash: markdownHash(w.vault["a.md"] ?? ""),
    });
  });

  it("reports overlapping edits as a conflict (REQ-5.2)", async () => {
    const w = world();
    synced(w, "a.md", "line\n");
    w.repo["a.md"] = "repo line\n";
    w.vault["a.md"] = "vault line\n";
    const result = await plan(input(w));
    expect(summary(result.actions)).toEqual(["conflict a.md"]);
    expect(result.actions[0]?.update.entry?.state).toBe("conflict");
  });

  it("adopts identical edits", async () => {
    const w = world();
    synced(w, "a.md", "x\n");
    w.repo["a.md"] = "same edit\r\n";
    w.vault["a.md"] = "same edit\n";
    expect(summary((await plan(input(w))).actions)).toEqual(["adopt a.md"]);
  });

  it("reports a conflict when the base's content is missing", async () => {
    const w = world();
    synced(w, "a.md", "x\n");
    w.blobs.clear();
    w.repo["a.md"] = "r\n";
    w.vault["a.md"] = "v\n";
    expect(summary((await plan(input(w))).actions)).toEqual(["conflict a.md"]);
  });

  it("leaves a conflicted file frozen until it's resolved (REQ-5.0.5)", async () => {
    const w = world();
    synced(w, "a.md", "x\n");
    agree(w, "a.md", "x\n", { state: "conflict" });
    w.vault["a.md"] = "more vault edits\n";
    const result = await plan(input(w));
    expect(result.actions).toEqual([]);
    expect(result.notices.map((n) => n.code)).toEqual(["conflict"]);
  });
});

describe("deletes and renames (REQ-6)", () => {
  it("moves the other side's copy to the trash", async () => {
    const w = world();
    synced(w, "a.md", "a\n");
    synced(w, "b.md", "b\n");
    delete w.repo["a.md"];
    delete w.vault["b.md"];
    expect(summary((await plan(input(w))).actions)).toEqual([
      "trash vault a.md",
      "trash repo b.md",
    ]);
  });

  it("forgets a file deleted on both sides", async () => {
    const w = world();
    agree(w, "a.md", "a\n");
    expect(summary((await plan(input(w))).actions)).toEqual(["record a.md forget"]);
  });

  it("keeps a file deleted on one side but changed on the other (REQ-6.4)", async () => {
    const w = world();
    synced(w, "a.md", "a\n");
    synced(w, "b.md", "b\n");
    delete w.vault["a.md"];
    w.repo["a.md"] = "a edited\n";
    delete w.repo["b.md"];
    w.vault["b.md"] = "b edited\n";
    const result = await plan(input(w));
    expect(summary(result.actions)).toEqual(["copy repo->vault a.md", "copy vault->repo b.md"]);
    expect(result.notices.map((n) => n.code)).toEqual(["delete-overridden", "delete-overridden"]);
  });

  it("carries a rename across instead of deleting and recreating (REQ-6.1)", async () => {
    const w = world();
    synced(w, "a.md", "content\n");
    delete w.vault["a.md"];
    w.vault["b.md"] = "content\n";
    const result = await plan(input(w));
    expect(summary(result.actions)).toEqual(["rename repo a.md->b.md"]);
    expect(result.actions[0]).toMatchObject({ removeKey: "a.md", update: { key: "b.md" } });
  });

  it("renames and then syncs the other side's edit to the renamed file", async () => {
    const w = world();
    synced(w, "a.md", "content\n");
    delete w.repo["a.md"];
    w.repo["guides/a.md"] = "content\n";
    w.vault["a.md"] = "content edited in Obsidian\n";
    const result = await plan(input(w));
    expect(summary(result.actions)).toEqual([
      "rename vault a.md->guides/a.md",
      "copy vault->repo guides/a.md",
    ]);
  });

  it("carries a case-only rename (REQ-6.2)", async () => {
    const w = world({ repoTraits: { isWindowsFs: true, caseInsensitive: true } });
    synced(w, "Readme.md", "r\n");
    delete w.repo["Readme.md"];
    w.repo["README.md"] = "r\n";
    expect(summary((await plan(input(w))).actions)).toEqual(["rename vault Readme.md->README.md"]);
  });

  it("treats a renamed file the other side deleted as new", async () => {
    const w = world();
    agree(w, "a.md", "c\n");
    w.repo["b.md"] = "c\n";
    expect(summary((await plan(input(w))).actions)).toEqual([
      "record a.md forget",
      "copy repo->vault b.md",
    ]);
  });

  it("detaches the repo copy when a note is moved into the private folder", async () => {
    const w = world();
    synced(w, "plan.md", "plan\n");
    delete w.vault["plan.md"];
    w.vault["private/plan.md"] = "plan\n";
    const result = await plan(input(w));
    expect(summary(result.actions)).toEqual([
      "record plan.md detached",
      "record private/plan.md vaultOnly",
    ]);
    expect(result.notices.map((n) => n.code)).toEqual(["no-longer-synced"]);
  });
});

describe("bulk guard (REQ-7.1)", () => {
  it("guards a pass that would delete many files", async () => {
    const w = world();
    for (let i = 0; i < 40; i++) synced(w, `doc${i}.md`, `${i}\n`);
    for (let i = 0; i < 30; i++) delete w.repo[`doc${i}.md`];
    expect((await plan(input(w))).bulk).toEqual({ destructive: 30, threshold: 10, guarded: true });
  });

  it("doesn't guard a first link that only copies new files", async () => {
    const repo: Record<string, string> = {};
    for (let i = 0; i < 50; i++) repo[`doc${i}.md`] = `${i}\n`;
    const result = await plan(input(world({ repo })));
    expect(result.bulk).toMatchObject({ destructive: 0, guarded: false });
  });
});

describe("sync rules (REQ-8)", () => {
  it("never copies a repo-only file to the vault (REQ-8.2)", async () => {
    const w = world({ repo: { "a.md": "---\nproject-docs: repo-only\n---\nx\n" } });
    expect(summary((await plan(input(w))).actions)).toEqual(["record a.md skipped"]);
  });

  it("doesn't send a vault edit to a repo-to-vault file, and keeps it as a conflict when the repo changes (REQ-8.3)", async () => {
    const w = world();
    const original = "---\nproject-docs: repo-to-vault\n---\noriginal\n";
    synced(w, "a.md", original);
    w.vault["a.md"] = "---\nproject-docs: repo-to-vault\n---\nvault edit\n";
    let result = await plan(input(w));
    expect(result.actions).toEqual([]);
    expect(result.notices.map((n) => n.code)).toEqual(["repo-to-vault-edit"]);

    w.repo["a.md"] = "---\nproject-docs: repo-to-vault\n---\nrepo edit\n";
    result = await plan(input(w));
    expect(summary(result.actions)).toEqual(["conflict a.md"]);
  });

  it("skips and reports an invalid rule (REQ-8.4)", async () => {
    const w = world({ vault: { "a.md": "---\nproject-docs: typo\n---\n" } });
    const result = await plan(input(w));
    expect(summary(result.actions)).toEqual(["record a.md skipped"]);
    expect(result.notices).toMatchObject([
      { code: "invalid-rule", message: expect.stringContaining("typo") },
    ]);
  });

  it("stops syncing a repo file that becomes repo-only, and points out the vault copy", async () => {
    const w = world();
    synced(w, "a.md", "a\n");
    w.repo["a.md"] = "---\nproject-docs: repo-only\n---\na\n";
    const result = await plan(input(w));
    expect(summary(result.actions)).toEqual(["record a.md skipped"]);
    expect(result.notices.map((n) => n.code)).toEqual(["repo-only-vault-copy"]);
  });
});

describe("private notes (REQ-10, design decision 9)", () => {
  it("never copies a note marked private or one in the private folder", async () => {
    const w = world({
      vault: { "marked.md": "---\nproject-docs: private\n---\n", "private/notes.md": "x\n" },
    });
    const result = await plan(input(w));
    expect(summary(result.actions)).toEqual([
      "record marked.md vaultOnly",
      "record private/notes.md vaultOnly",
    ]);
    expect(result.notices).toEqual([]);
  });

  it("leaves the repo copy of a synced note made private, and says so", async () => {
    const w = world();
    synced(w, "a.md", "a\n");
    w.vault["a.md"] = "---\nproject-docs: private\n---\na\n";
    const result = await plan(input(w));
    expect(summary(result.actions)).toEqual(["record a.md vaultOnly"]);
    expect(result.notices.map((n) => n.code)).toEqual(["no-longer-synced"]);
  });

  it("doesn't re-read an unchanged private note", async () => {
    const w = world({ vault: { "private/a.md": "x\n" } });
    agree(w, "private/a.md", "x\n", { state: "vaultOnly", reasons: ["in the private folder"] });
    const reads: string[] = [];
    const base = input(w);
    const result = await plan({
      ...base,
      readText: async (side, key) => (reads.push(key), base.readText(side, key)),
    });
    expect(result.actions).toEqual([]);
    expect(reads).toEqual([]);
  });

  it("knows a private note from an earlier pass when another note links to it", async () => {
    const w = world({
      vault: { "marked.md": "---\nproject-docs: private\n---\n", "a.md": "[[marked]]\n" },
    });
    agree(w, "marked.md", "---\nproject-docs: private\n---\n", {
      state: "vaultOnly",
      reasons: ["marked.md is marked private"],
    });
    const result = await plan(input(w));
    expect(result.notices).toMatchObject([{ key: "a.md", code: "held-back" }]);
  });
});

describe("held-back changes (REQ-13, design decision 5)", () => {
  it("holds back a link to a private note, keeping the base (REQ-13.1)", async () => {
    const w = world({ vault: { "private/server-notes.md": "s\n" } });
    synced(w, "guide.md", "guide\n");
    w.vault["guide.md"] = "guide\n[[private/server-notes]]\n";
    const result = await plan(input(w));
    expect(summary(result.actions)).toEqual([
      "record guide.md heldBack",
      "record private/server-notes.md vaultOnly",
    ]);
    expect(result.actions[0]?.update.entry?.baseHash).toBe(markdownHash("guide\n"));
    expect(result.notices.find((n) => n.code === "held-back")?.reasons?.[0]).toContain(
      "private/server-notes",
    );
  });

  it("doesn't write repo changes into a held-back vault file", async () => {
    const w = world();
    synced(w, "guide.md", "guide\n");
    w.vault["guide.md"] = "guide\n[[private/x]]\n";
    w.vault["private/x.md"] = "x\n";
    agree(w, "guide.md", "guide\n", { state: "heldBack" });
    w.repo["guide.md"] = "guide edited by an agent\n";
    const result = await plan(input(w));
    expect(result.actions.filter((a) => a.type === "copy" || a.type === "writeBoth")).toEqual([]);
    expect(result.notices.find((n) => n.code === "held-back")?.reasons).toContain(
      "the repo copy has also changed; it syncs once the vault copy can",
    );
  });

  it("syncs once the cause is removed (REQ-13.0.4)", async () => {
    const w = world();
    synced(w, "guide.md", "guide\n");
    agree(w, "guide.md", "guide\n", { state: "heldBack" });
    w.vault["guide.md"] = "guide, with the link removed\n";
    expect(summary((await plan(input(w))).actions)).toEqual(["copy vault->repo guide.md"]);
  });

  it("marks a held-back file synced again when it's reverted", async () => {
    const w = world();
    synced(w, "guide.md", "guide\n");
    agree(w, "guide.md", "guide\n", { state: "heldBack" });
    expect(summary((await plan(input(w))).actions)).toEqual(["record guide.md synced"]);
  });

  it("holds back a link outside the project folder unless allowed (REQ-13.2)", async () => {
    const w = world({ outside: ["Journal/today.md"] });
    synced(w, "a.md", "a\n");
    w.vault["a.md"] = "a [[today]]\n";
    expect(summary((await plan(input(w))).actions)).toEqual(["record a.md heldBack"]);
    w.settings = { ...w.settings, allowLinksOutsideProjectFolder: true };
    expect(summary((await plan(input(w))).actions)).toEqual(["copy vault->repo a.md"]);
  });

  it("holds back a real value from PRIVATE.md (REQ-13.3)", async () => {
    const w = world({ mapping: new Map([["myhost", "DESK-FAKE01"]]) });
    synced(w, "a.md", "a\n");
    w.vault["a.md"] = "ssh desk-fake01\n";
    const result = await plan(input(w));
    expect(summary(result.actions)).toEqual(["record a.md heldBack"]);
    expect(JSON.stringify(result).toLowerCase()).not.toContain("desk-fake01");
    // The notice offers the fix only when a real value is among the reasons.
    expect(result.notices).toMatchObject([{ code: "held-back", fix: "replace-real-values" }]);
    w.vault["a.md"] = "a [[today]]\n";
    expect((await plan(input(w))).notices[0]?.fix).toBeUndefined();
  });
});

describe("links between docs (REQ-12)", () => {
  it("converts wikilinks in a vault change and writes the result to both sides", async () => {
    const w = world();
    synced(w, "Setup Guide.md", "s\n");
    synced(w, "index.md", "i\n");
    w.vault["index.md"] = "See [[Setup Guide|setup]].\n";
    const [action] = (await plan(input(w))).actions;
    expect(action).toMatchObject({ type: "writeBoth", text: "See [setup](Setup%20Guide.md).\n" });
  });

  it("leaves links as written with the setting on", async () => {
    const w = world();
    synced(w, "Setup Guide.md", "s\n");
    synced(w, "index.md", "i\n");
    w.vault["index.md"] = "See [[Setup Guide|setup]].\n";
    w.settings = { ...w.settings, keepLinksAsWritten: true };
    expect(summary((await plan(input(w))).actions)).toEqual(["copy vault->repo index.md"]);
  });

  it("reports a link that has no Markdown equivalent, and still syncs", async () => {
    const w = world();
    synced(w, "a.md", "a\n");
    synced(w, "b.md", "b\n");
    w.vault["a.md"] = "[[b#^block1]]\n";
    const result = await plan(input(w));
    expect(summary(result.actions)).toEqual(["copy vault->repo a.md"]);
    expect(result.notices.map((n) => n.code)).toEqual(["unconvertible-links"]);
  });
});

describe("attachments (REQ-11)", () => {
  it("ignores attachments by default, without trashing ones synced earlier (REQ-11.1)", async () => {
    const w = world({ repo: { "a.png": "png" }, vault: { "a.png": "png" } });
    agree(w, "a.png", "png");
    expect(summary((await plan(input(w))).actions)).toEqual(["record a.png forget"]);
  });

  it("syncs attachments when switched on, as a conflict when both change (REQ-11.2)", async () => {
    const w = world({ repo: { "new.png": "n" } });
    w.settings = { ...w.settings, syncAttachments: true };
    synced(w, "both.png", "b");
    w.repo["both.png"] = "repo pixels";
    w.vault["both.png"] = "vault pixels";
    expect(summary((await plan(input(w))).actions)).toEqual([
      "conflict both.png",
      "copy repo->vault new.png",
    ]);
  });

  it("keeps a private-listed attachment vault-only wherever it moves (REQ-11.3)", async () => {
    const w = world({ vault: { "copy of shot.png": "pixels" } });
    w.settings = { ...w.settings, syncAttachments: true };
    w.privateFiles = parsePrivateFilesList(
      JSON.stringify({ files: [{ path: "private/shot.png", sha256: sha256("pixels") }] }),
    );
    expect(summary((await plan(input(w))).actions)).toEqual(["record copy of shot.png vaultOnly"]);
  });
});

describe("platforms (REQ-16)", () => {
  it("doesn't copy a name Windows can't hold (REQ-16.2)", async () => {
    const w = world({
      repo: { "notes:draft.md": "x\n" },
      vaultTraits: { isWindowsFs: true, caseInsensitive: true },
    });
    const result = await plan(input(w));
    expect(result.actions.filter((a) => a.type === "copy")).toEqual([]);
    expect(result.notices.map((n) => n.code)).toEqual(["not-portable"]);
  });

  it("copies neither of two names that clash by case on a case-insensitive side (REQ-16.3)", async () => {
    const w = world({
      repo: { "Plan.md": "a\n", "plan.md": "b\n" },
      vaultTraits: { isWindowsFs: true, caseInsensitive: true },
    });
    const result = await plan(input(w));
    expect(result.actions).toEqual([]);
    expect(result.notices.map((n) => [n.key, n.code])).toEqual([
      ["Plan.md", "case-clash"],
      ["plan.md", "case-clash"],
    ]);
  });
});

describe("the link note", () => {
  it("never syncs the link note to the repo (REQ-2.9)", async () => {
    const w = world({
      vault: { "repo.md": "---\nproject-docs: sync\n---\n" },
      linkNoteKey: "repo.md",
    });
    expect(summary((await plan(input(w))).actions)).toEqual(["record repo.md vaultOnly"]);
  });
});

it("reports files the scanner skipped", async () => {
  const w = world();
  const base = input(w);
  const result = await plan({
    ...base,
    repo: {
      ...base.repo,
      skipped: [{ key: "big.md", reason: "too-large", message: "big.md is larger than 5 MB" }],
    },
  });
  expect(result.notices).toEqual([
    { key: "big.md", code: "scan-skipped", message: "big.md is larger than 5 MB" },
  ]);
});

it("hashes keys the same way the scanner does", () => {
  expect(hashOf("a.md", "x\r\n")).toBe(markdownHash("x\n"));
});
