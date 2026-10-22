import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { COMMITTED_SCHEMA } from "@specdevship/project-docs-core";
import { DESKTOP_ONLY_MESSAGE, activate } from "../../src/web.js";
import { calls } from "./vscode-stub.js";

const here = path.dirname(fileURLToPath(import.meta.url));

describe("web stub (REQ-21.0.3)", () => {
  it("tells browser-based VS Code users the extension needs desktop VS Code", () => {
    activate();
    expect(calls).toEqual([
      { method: "window.showInformationMessage", args: [DESKTOP_ONLY_MESSAGE] },
    ]);
    expect(DESKTOP_ONLY_MESSAGE).toContain("needs desktop VS Code");
  });
});

describe("shipped JSON schema", () => {
  it("matches the core's schema for .project-docs.json", () => {
    const shipped = JSON.parse(
      readFileSync(path.join(here, "..", "..", "schemas", "project-docs.schema.json"), "utf8"),
    );
    expect(shipped).toEqual(JSON.parse(JSON.stringify(COMMITTED_SCHEMA)));
  });
});
