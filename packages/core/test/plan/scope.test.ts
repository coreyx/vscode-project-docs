import { describe, expect, it } from "vitest";
import { plan, type PlanInput } from "../../src/plan/index.js";
import { createScope, type Scope } from "../../src/scan/index.js";
import { input, synced, world, type World } from "./world.js";

/** The planner's input, with out-of-scope keys left out of both snapshots as the scanner would. */
function scoped(w: World, scope: Scope): PlanInput {
  for (const side of [w.repo, w.vault]) {
    for (const key of Object.keys(side)) if (!scope.includes(key)) delete side[key];
  }
  return { ...input(w), scope };
}

describe("entries that leave the scope (REQ-22.0.4, design decision 21)", () => {
  it("are forgotten without touching either copy, and without a notice", async () => {
    const w = world();
    synced(w, "docs/guide.md", "guide\n");
    synced(w, "CHANGELOG.md", "changes\n");
    const planned = await plan(scoped(w, createScope("docs", [])));
    expect(planned.notices).toEqual([]);
    expect(planned.actions).toEqual([
      { type: "record", key: "CHANGELOG.md", update: { key: "CHANGELOG.md", entry: null } },
    ]);
  });

  it("aren't taken for one side of a rename by a new file with the same content", async () => {
    const w = world();
    synced(w, "CHANGELOG.md", "same\n");
    w.vault["docs/CHANGELOG.md"] = "same\n";
    const planned = await plan(scoped(w, createScope("docs", [])));
    expect(planned.actions.some((a) => a.type === "rename" || a.type === "trash")).toBe(false);
    expect(planned.actions).toContainEqual(
      expect.objectContaining({ type: "copy", key: "docs/CHANGELOG.md", from: "vault" }),
    );
  });
});
