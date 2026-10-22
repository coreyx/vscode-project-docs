/**
 * Integration tests that run inside VS Code: the extension loads and activates on desktop, as a
 * workspace extension, with a browser entry that points at the built web stub (REQ-21.0.3).
 */
import * as assert from "node:assert/strict";
import { existsSync } from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";

const ID = "specdevship.project-docs";

describe("Project Docs extension", () => {
  it("is installed and activates in desktop VS Code", async () => {
    const extension = vscode.extensions.getExtension(ID);
    assert.ok(extension, `${ID} should be installed`);
    await extension.activate();
    assert.equal(extension.isActive, true);
  });

  it("runs where the workspace is, and ships a browser stub", () => {
    const extension = vscode.extensions.getExtension(ID);
    assert.ok(extension);
    const manifest = extension.packageJSON as { extensionKind: string[]; browser: string };
    assert.deepEqual(manifest.extensionKind, ["workspace"]);
    assert.ok(
      existsSync(path.join(extension.extensionPath, manifest.browser)),
      "the web stub is built",
    );
  });

  it("validates .project-docs.json with the shipped schema", () => {
    const extension = vscode.extensions.getExtension(ID);
    assert.ok(extension);
    const manifest = extension.packageJSON as {
      contributes: { jsonValidation: { url: string }[] };
    };
    const schema = manifest.contributes.jsonValidation[0]?.url ?? "";
    assert.ok(existsSync(path.join(extension.extensionPath, schema)));
  });
});
