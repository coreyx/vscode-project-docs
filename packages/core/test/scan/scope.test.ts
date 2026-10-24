import { describe, expect, it } from "vitest";
import { createScope, privateFolderKey } from "../../src/scan/index.js";

describe("createScope (REQ-22, design decision 21)", () => {
  it("takes the docs folder and the listed root files, and nothing else", () => {
    const scope = createScope("docs", ["README.md", "CHANGELOG.md"]);
    expect(scope.includes("docs/guide.md")).toBe(true);
    expect(scope.includes("docs/deep/a.md")).toBe(true);
    expect(scope.includes("README.md")).toBe(true);
    expect(scope.includes("CHANGELOG.md")).toBe(true);
    expect(scope.includes("CONTRIBUTING.md")).toBe(false);
    expect(scope.includes("src/notes.md")).toBe(false);
    // A root file's name elsewhere is just another file.
    expect(scope.includes("src/README.md")).toBe(false);
    expect(scope.includes("docs-old/a.md")).toBe(false);
    expect(scope.includes("docs")).toBe(false);
  });

  it("enters only the docs folder, the folders leading to it, and what's below it", () => {
    const scope = createScope("site/docs", []);
    expect(scope.mayContain("site")).toBe(true);
    expect(scope.mayContain("site/docs")).toBe(true);
    expect(scope.mayContain("site/docs/deep")).toBe(true);
    expect(scope.mayContain("src")).toBe(false);
    expect(scope.mayContain("site/other")).toBe(false);
    expect(scope.mayContain("sit")).toBe(false);
  });

  it("has everything in scope for a repo-root link, whatever rootFiles says (AC 22.7)", () => {
    for (const docs of ["", "/", "//"]) {
      const scope = createScope(docs, []);
      expect(scope.includes("src/notes.md")).toBe(true);
      expect(scope.includes("CONTRIBUTING.md")).toBe(true);
      expect(scope.mayContain("anything")).toBe(true);
    }
  });
});

describe("privateFolderKey", () => {
  it("puts the private subfolder inside the docs folder", () => {
    expect(privateFolderKey("docs", "private")).toBe("docs/private");
    expect(privateFolderKey("site/docs", "secret")).toBe("site/docs/secret");
    expect(privateFolderKey("", "private")).toBe("private");
  });
});
