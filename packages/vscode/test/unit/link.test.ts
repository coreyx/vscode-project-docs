import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { LOCAL_FILE, readLink } from "@specdevship/project-docs-core";
import { runLinkFlow, type FlowContext, type Prompter } from "../../src/link/flow.js";
import { checkNesting, createLink, removeLink } from "../../src/link/linker.js";
import { parseRegistry, registryCandidates, type KnownVault } from "../../src/link/vaults.js";

let root: string;
let repo: string;
let vault: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "pd-link-"));
  repo = path.join(root, "my-repo");
  vault = path.join(root, "Vault");
  await mkdir(path.join(repo, "docs"), { recursive: true });
  await mkdir(vault, { recursive: true });
  spawnSync("git", ["init", "-q", repo]);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** A prompter that accepts every default and records what it was asked. */
function acceptingPrompter(
  asked: string[],
  overrides: Partial<Record<keyof Prompter, string>> = {},
): Prompter {
  return {
    docsFolder: async (d) => (asked.push(`docs:${d}`), overrides.docsFolder ?? d),
    vault: async (_v, d) => (asked.push(`vault:${d ?? ""}`), overrides.vault ?? d),
    vaultFolder: async (d) => (asked.push(`folder:${d}`), overrides.vaultFolder ?? d),
  };
}

function context(
  prompter: Prompter,
  vaults: KnownVault[] = [{ name: "Vault", path: vault, lastOpened: 1 }],
  lastVault?: string,
) {
  const remembered: string[] = [];
  const ctx: FlowContext = {
    prompter,
    knownVaults: async () => vaults,
    lastVault,
    rememberVault: async (v) => {
      remembered.push(v);
    },
    wsl: null,
  };
  return { ctx, remembered };
}

describe("the link flow (REQ-1.1)", () => {
  it("links with three prompts, each with a usable default", async () => {
    const asked: string[] = [];
    const { ctx, remembered } = context(acceptingPrompter(asked));
    expect(await runLinkFlow(repo, ctx)).toEqual({ outcome: "linked", repoRoot: repo });
    expect(asked).toEqual(["docs:docs", `vault:${vault}`, "folder:Projects/my-repo"]);
    expect(remembered).toEqual([vault]);
    const state = await readLink(repo);
    expect(state).toMatchObject({
      state: "linked",
      committed: { docsFolder: "docs", vaultFolder: "Projects/my-repo" },
    });
    const note = await readFile(path.join(vault, "Projects", "my-repo", "my-repo.md"), "utf8");
    expect(note).toContain("project-docs-repo:");
  });

  it("offers the vault chosen last time first (REQ-1.2)", async () => {
    const asked: string[] = [];
    const other = path.join(root, "Other Vault");
    await mkdir(other);
    const { ctx } = context(
      acceptingPrompter(asked),
      [{ name: "Vault", path: vault, lastOpened: 9 }],
      other,
    );
    await runLinkFlow(repo, ctx);
    expect(asked[1]).toBe(`vault:${other}`);
  });

  it("stops without writing anything when a prompt is cancelled", async () => {
    const prompter: Prompter = { ...acceptingPrompter([]), vault: async () => undefined };
    expect(await runLinkFlow(repo, context(prompter).ctx)).toEqual({ outcome: "cancelled" });
    expect((await readLink(repo)).state).toBe("unlinked");
  });

  it("refuses a vault folder inside the repo, writing nothing (REQ-1.4)", async () => {
    const prompter = acceptingPrompter([], { vault: repo, vaultFolder: "notes" });
    const result = await runLinkFlow(repo, context(prompter).ctx);
    expect(result).toMatchObject({
      outcome: "refused",
      message: expect.stringContaining("inside the repo"),
    });
    expect((await readLink(repo)).state).toBe("unlinked");
  });

  it("refuses a docs folder inside the vault (REQ-1.4)", async () => {
    const repoInVault = path.join(vault, "repo");
    await mkdir(path.join(repoInVault, "docs"), { recursive: true });
    const result = await runLinkFlow(
      repoInVault,
      context(acceptingPrompter([], { vaultFolder: "Elsewhere" })).ctx,
    );
    expect(result).toMatchObject({
      outcome: "refused",
      message: expect.stringContaining("inside the vault"),
    });
  });

  it("re-links with the recorded folders and the same project id (REQ-2.5)", async () => {
    await runLinkFlow(repo, context(acceptingPrompter([])).ctx);
    const before = await readLink(repo);
    await rm(path.join(repo, LOCAL_FILE));
    const asked: string[] = [];
    await runLinkFlow(repo, context(acceptingPrompter(asked)).ctx);
    expect(asked).toEqual([`vault:${vault}`, "folder:Projects/my-repo"]);
    const after = await readLink(repo);
    expect(after.state === "linked" && after.committed.projectId).toBe(
      before.state === "linked" && before.committed.projectId,
    );
  });
});

describe("createLink and removeLink", () => {
  it("rejects folders that aren't inside their root", async () => {
    await expect(
      createLink({ repoRoot: repo, docsFolder: "../x", vaultRoot: vault, vaultFolder: "P" }, null),
    ).rejects.toThrow("docs folder must be a folder inside its root");
    await expect(
      createLink(
        { repoRoot: repo, docsFolder: "docs", vaultRoot: vault, vaultFolder: "C:\\x" },
        null,
      ),
    ).rejects.toThrow("vault folder");
  });

  it("unlinks without moving or deleting any file (REQ-1.5)", async () => {
    await createLink(
      { repoRoot: repo, docsFolder: "docs", vaultRoot: vault, vaultFolder: "Projects/my-repo" },
      null,
    );
    await writeFile(path.join(repo, "docs", "a.md"), "a\n");
    const note = path.join(vault, "Projects", "my-repo", "my-repo.md");
    await removeLink(repo);
    expect((await readLink(repo)).state).toBe("unlinked");
    expect(await readFile(path.join(repo, "docs", "a.md"), "utf8")).toBe("a\n");
    const noteText = await readFile(note, "utf8");
    expect(noteText).not.toContain("project-docs-id");
    expect(noteText).toContain("Open the repo in VS Code");
  });

  it("unlinks a repo whose link note is gone", async () => {
    await createLink(
      { repoRoot: repo, docsFolder: "docs", vaultRoot: vault, vaultFolder: "P" },
      null,
    );
    await rm(path.join(vault, "P"), { recursive: true });
    await removeLink(repo);
    expect((await readLink(repo)).state).toBe("unlinked");
  });

  it("finds nesting through folders that don't exist yet", async () => {
    expect(
      await checkNesting(repo, path.join(repo, "docs"), vault, path.join(vault, "new", "deep")),
    ).toBeNull();
    expect(
      await checkNesting(repo, path.join(repo, "docs"), repo, path.join(repo, "new", "deep")),
    ).toContain("inside the repo");
  });
});

describe("Obsidian's vault registry", () => {
  it("knows where Obsidian keeps it on each platform", () => {
    expect(
      registryCandidates("win32", { APPDATA: "C:\\Users\\me\\AppData\\Roaming" }, "C:\\Users\\me"),
    ).toEqual(["C:\\Users\\me\\AppData\\Roaming\\obsidian\\obsidian.json"]);
    expect(registryCandidates("darwin", {}, "/Users/me")).toEqual([
      "/Users/me/Library/Application Support/obsidian/obsidian.json",
    ]);
    expect(registryCandidates("linux", {}, "/home/me")).toEqual([
      "/home/me/.config/obsidian/obsidian.json",
      "/home/me/.var/app/md.obsidian.Obsidian/config/obsidian/obsidian.json",
      "/home/me/snap/obsidian/current/.config/obsidian/obsidian.json",
    ]);
  });

  it("reads vaults, and translates Windows paths when read from WSL", () => {
    const text = JSON.stringify({
      vaults: {
        a: { path: "C:\\Users\\me\\Notes", ts: 5 },
        b: { path: "D:\\Work Vault", ts: 9 },
        c: { nope: true },
      },
    });
    expect(parseRegistry(text, null, false).map((v) => [v.name, v.path])).toEqual([
      ["Notes", "C:\\Users\\me\\Notes"],
      ["Work Vault", "D:\\Work Vault"],
    ]);
    const wsl = { distro: "Ubuntu", automountRoot: "/mnt/" };
    expect(parseRegistry(text, wsl, true).map((v) => v.path)).toEqual([
      "/mnt/c/Users/me/Notes",
      "/mnt/d/Work Vault",
    ]);
  });

  it("ignores a registry it can't read", () => {
    expect(parseRegistry("{ broken", null, false)).toEqual([]);
    expect(parseRegistry("{}", null, false)).toEqual([]);
  });
});
