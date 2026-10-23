import { describe, expect, it } from "vitest";
import { plan, type Action, type PlanInput } from "../../src/plan/index.js";
import { inNodeModules, type IgnoreRules } from "../../src/scan/index.js";
import { agree, input, synced, world, type World } from "./world.js";

/** Rules that skip, and git-ignore, keys under the given folders or equal to the given files. */
function rules(...ignored: string[]): IgnoreRules {
  const gitIgnores = (key: string) =>
    ignored.some((p) => (p.endsWith("/") ? `${key}/`.startsWith(p) : key === p));
  const skips = (key: string) => inNodeModules(key) || gitIgnores(key);
  return { skips, gitIgnores, skipsFolder: skips };
}

/** The planner's input, with ignored keys left out of both snapshots as the scanner would. */
function ignoring(w: World, ignore: IgnoreRules): PlanInput {
  for (const side of [w.repo, w.vault]) {
    for (const key of Object.keys(side)) if (ignore.skips(key, false)) delete side[key];
  }
  return { ...input(w), ignore };
}

/** The index updates of record actions, as key -> new state (or null when forgotten). */
function recorded(actions: readonly Action[]): Record<string, string | null> {
  return Object.fromEntries(
    actions.filter((a) => a.type === "record").map((a) => [a.key, a.update.entry?.state ?? null]),
  );
}

describe("synced notes that become ignored (REQ-3.0.8, design decision 20)", () => {
  it("are set aside as ignored, with one notice per folder, and neither copy touched", async () => {
    const w = world();
    synced(w, "guide.md", "guide\n");
    synced(w, "drafts/a.md", "a\n");
    synced(w, "drafts/sub/b.md", "b\n");
    const planned = await plan(ignoring(w, rules("drafts/")));
    expect(planned.actions.filter((a) => a.type !== "record")).toEqual([]);
    expect(recorded(planned.actions)).toEqual({
      "drafts/a.md": "ignored",
      "drafts/sub/b.md": "ignored",
    });
    expect(planned.notices).toEqual([
      {
        key: "drafts/",
        code: "now-ignored",
        message:
          "drafts/ is ignored by git, so its 2 synced files have stopped syncing. Both copies are kept as they are.",
        reasons: ["drafts/a.md", "drafts/sub/b.md"],
        fix: "sync-ignored",
      },
    ]);
  });

  it("aren't taken for one side of a rename by a new file with the same content", async () => {
    const w = world();
    synced(w, "drafts/a.md", "same\n");
    w.vault["copy.md"] = "same\n";
    const planned = await plan(ignoring(w, rules("drafts/")));
    expect(planned.actions.some((a) => a.type === "rename" || a.type === "trash")).toBe(false);
    expect(planned.actions).toContainEqual(
      expect.objectContaining({ type: "copy", key: "copy.md", from: "vault" }),
    );
  });

  it("are reported on every pass while ignored, without being recorded again", async () => {
    const w = world();
    agree(w, "drafts/a.md", "a\n", { state: "ignored", reasons: ["ignored by git"] });
    const planned = await plan(ignoring(w, rules("drafts/")));
    expect(recorded(planned.actions)).toEqual({});
    expect(planned.notices).toMatchObject([
      { key: "drafts/", code: "now-ignored", reasons: ["drafts/a.md"] },
    ]);
    expect(planned.notices[0]?.message).toContain("its synced file has stopped syncing");
  });

  it("are reported by file when only the file is ignored", async () => {
    const w = world();
    synced(w, "notes/solo.md", "solo\n");
    const planned = await plan(ignoring(w, rules("notes/solo.md")));
    expect(planned.notices).toEqual([
      {
        key: "notes/solo.md",
        code: "now-ignored",
        message:
          "notes/solo.md is ignored by git, so it has stopped syncing. Both copies are kept as they are.",
        fix: "sync-ignored",
      },
    ]);
  });

  it("can only be stopped in node_modules, which never syncs", async () => {
    const w = world();
    synced(w, "site/node_modules/pkg/README.md", "pkg\n");
    const planned = await plan(ignoring(w, rules()));
    expect(planned.notices).toMatchObject([
      { key: "site/node_modules/", code: "now-ignored", fix: "stop-syncing" },
    ]);
    expect(planned.notices[0]?.message).toContain("is in node_modules, which never syncs");
  });

  it("names the first 20 files of a folder and counts the rest", async () => {
    const w = world();
    for (let i = 10; i < 35; i++) synced(w, `drafts/${i}.md`, `${i}\n`);
    const [notice] = (await plan(ignoring(w, rules("drafts/")))).notices;
    expect(notice?.reasons).toHaveLength(21);
    expect(notice?.reasons?.[20]).toBe("and 5 more");
  });

  it("leaves other entries as they are, so a private note stays known, and a conflict reported", async () => {
    const w = world();
    agree(w, "drafts/private.md", "secret\n", { state: "vaultOnly", reasons: ["marked private"] });
    agree(w, "drafts/clash.md", "base\n", { state: "conflict" });
    const planned = await plan(ignoring(w, rules("drafts/")));
    expect(recorded(planned.actions)).toEqual({});
    expect(planned.notices.map((n) => n.code)).toEqual(["conflict"]);
  });

  it("sync again from their kept base once they're no longer ignored, merging an edit from each side", async () => {
    const w = world();
    agree(w, "drafts/a.md", "one\ntwo\nthree\n", { state: "ignored", reasons: ["ignored by git"] });
    w.repo["drafts/a.md"] = "one, from the repo\ntwo\nthree\n";
    w.vault["drafts/a.md"] = "one\ntwo\nthree, from the vault\n";
    const planned = await plan({ ...input(w), ignore: rules() });
    expect(planned.notices).toEqual([]);
    expect(planned.actions[0]).toMatchObject({
      type: "record",
      key: "drafts/a.md",
      update: { entry: { state: "synced", reasons: [] } },
    });
    expect(planned.actions).toContainEqual(
      expect.objectContaining({
        type: "writeBoth",
        key: "drafts/a.md",
        text: "one, from the repo\ntwo\nthree, from the vault\n",
      }),
    );
    expect(planned.actions.some((a) => a.type === "conflict")).toBe(false);
  });
});
