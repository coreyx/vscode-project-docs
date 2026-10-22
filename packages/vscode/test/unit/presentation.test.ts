import { describe, expect, it } from "vitest";
import * as path from "node:path";
import { kindLabel, resolveAction, statusText } from "../../src/ui/presentation.js";

const plan = { actions: [], notices: [], bulk: { destructive: 25, threshold: 10, guarded: true } };

describe("statusText (REQ-17.0.1)", () => {
  it("names each state", () => {
    expect(statusText({ state: "idle" }).text).toBe("$(check) Up to date");
    expect(statusText({ state: "syncing" }).text).toBe("$(sync~spin) Syncing");
    expect(statusText({ state: "paused" }).text).toBe("$(debug-pause) Paused");
    expect(statusText({ state: "attention", count: 1 }).text).toBe("$(warning) 1 needs attention");
    expect(statusText({ state: "attention", count: 3 }).text).toBe("$(warning) 3 need attention");
    expect(statusText({ state: "bulk", plan }).tooltip).toContain("25 files");
    expect(statusText({ state: "starting" }).text).toContain("Project Docs");
    expect(statusText({ state: "error", message: "boom" })).toEqual({
      text: "$(error) Project Docs",
      tooltip: "boom",
    });
  });

  it("says who holds the lock", () => {
    const base = { pid: 1, host: "h", token: "t", heartbeatAt: "" };
    expect(
      statusText({ state: "elsewhere", heldBy: { ...base, owner: "vscode", window: "notes" } })
        .tooltip,
    ).toContain("(notes)");
    expect(statusText({ state: "elsewhere", heldBy: { ...base, owner: "cli" } }).tooltip).toContain(
      "project-docs command",
    );
    expect(statusText({ state: "elsewhere", heldBy: null }).text).toBe(
      "$(lock) Syncing in another window",
    );
  });
});

describe("resolveAction (REQ-17.0.2)", () => {
  const roots = { repo: path.join("r", "docs"), vault: path.join("v", "P") };
  const item = (kind: string) => ({ kind, path: "guides/a.md", message: "m", reasons: [] });

  it("opens the merge editor for a conflict", () => {
    expect(resolveAction(item("conflict"), roots, path.join)).toEqual({
      title: "Resolve conflict",
      command: "projectDocs.openConflict",
      arguments: ["guides/a.md"],
    });
  });

  it("prefers the vault copy for problems fixed in Obsidian", () => {
    for (const kind of [
      "held-back",
      "repo-to-vault-edit",
      "unconvertible-links",
      "no-longer-synced",
    ]) {
      expect(resolveAction(item(kind), roots, path.join).arguments).toEqual([
        path.join("v", "P", "guides", "a.md"),
        path.join("r", "docs", "guides", "a.md"),
      ]);
    }
  });

  it("prefers the repo copy for the rest, and shows the log for failing writes", () => {
    for (const kind of ["invalid-rule", "not-portable", "case-clash", "scan-skipped"]) {
      expect(resolveAction(item(kind), roots, path.join).arguments).toEqual([
        path.join("r", "docs", "guides", "a.md"),
        path.join("v", "P", "guides", "a.md"),
      ]);
    }
    expect(resolveAction(item("write-failing"), roots, path.join).command).toBe(
      "projectDocs.showLog",
    );
  });

  it("labels every kind", () => {
    expect(kindLabel("held-back")).toBe("held back");
    expect(kindLabel("something-new")).toBe("something-new");
  });
});
