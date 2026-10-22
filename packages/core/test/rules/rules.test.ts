import { describe, expect, it } from "vitest";
import {
  FrontmatterError,
  findFrontmatter,
  isInvalidRule,
  readProperty,
  readRule,
  removeProperties,
  setProperties,
  setRule,
  yamlScalar,
} from "../../src/rules/index.js";

describe("findFrontmatter", () => {
  it("finds a block that starts on the first line", () => {
    const block = findFrontmatter("---\ntitle: x\n---\nbody\n");
    expect(block?.yaml).toBe("title: x\n");
    expect(block?.eol).toBe("\n");
  });

  it("handles CRLF files and a byte-order mark", () => {
    const block = findFrontmatter("\ufeff---\r\ntitle: x\r\n---\r\nbody");
    expect(block?.yaml).toBe("title: x\r\n");
    expect(block?.eol).toBe("\r\n");
  });

  it("ignores a --- that isn't on the first line, or isn't closed", () => {
    expect(findFrontmatter("text\n---\na: b\n---\n")).toBeNull();
    expect(findFrontmatter("---\na: b\n")).toBeNull();
    expect(findFrontmatter("no frontmatter")).toBeNull();
  });

  it("finds an empty block", () => {
    expect(findFrontmatter("---\n---\nbody")?.yaml).toBe("");
  });
});

describe("readRule", () => {
  it("defaults to sync when the property is absent (REQ-8.1)", () => {
    expect(readRule("# Title\n")).toBe("sync");
    expect(readRule("---\ntitle: x\n---\n")).toBe("sync");
    expect(readRule("---\n---\n")).toBe("sync");
  });

  it.each(["sync", "repo-to-vault", "repo-only", "private"] as const)("reads %s", (rule) => {
    expect(readRule(`---\nproject-docs: ${rule}\n---\nbody`)).toBe(rule);
  });

  it("reports an invalid value, naming it (REQ-8.4)", () => {
    const rule = readRule("---\nproject-docs: typo\n---\n");
    expect(isInvalidRule(rule) && rule.value).toBe("typo");
    expect(isInvalidRule(rule) && rule.message).toContain('"typo"');
  });

  it("reports an empty value, a number, a list and broken YAML as invalid", () => {
    expect(isInvalidRule(readRule("---\nproject-docs:\n---\n"))).toBe(true);
    expect(isInvalidRule(readRule("---\nproject-docs: 3\n---\n"))).toBe(true);
    expect(isInvalidRule(readRule("---\nproject-docs: [sync]\n---\n"))).toBe(true);
    const broken = readRule("---\nproject-docs: sync\n  bad: : indent\n---\n");
    expect(isInvalidRule(broken) && broken.message).toContain("isn't valid YAML");
  });

  it("reports frontmatter that isn't a map as invalid", () => {
    expect(isInvalidRule(readRule("---\n- a\n- b\n---\n"))).toBe(true);
  });

  it("only looks at top-level properties", () => {
    expect(readRule("---\nnested:\n  project-docs: private\n---\n")).toBe("sync");
  });
});

describe("setRule leaves everything else byte-identical (REQ-9.2)", () => {
  it("replaces an existing value in place", () => {
    const before = "---\ntitle: A  # comment\nproject-docs: sync\ntags: [a, b]\n---\nBody\n";
    expect(setRule(before, "private")).toBe(
      "---\ntitle: A  # comment\nproject-docs: private\ntags: [a, b]\n---\nBody\n",
    );
  });

  it("appends the property to existing frontmatter", () => {
    const before = "---\ntitle: 'Quoted: yes'\naliases:\n  - one\n---\nBody\n";
    expect(setRule(before, "repo-only")).toBe(
      "---\ntitle: 'Quoted: yes'\naliases:\n  - one\nproject-docs: repo-only\n---\nBody\n",
    );
  });

  it("creates frontmatter when there is none, in the file's line endings", () => {
    expect(setRule("Body\r\n", "private")).toBe("---\r\nproject-docs: private\r\n---\r\nBody\r\n");
    expect(setRule("Body", "sync")).toBe("---\nproject-docs: sync\n---\nBody");
  });

  it("keeps CRLF line endings and the byte-order mark", () => {
    const before = "\ufeff---\r\ntitle: x\r\nproject-docs: sync\r\n---\r\nBody\r\n";
    expect(setRule(before, "repo-to-vault")).toBe(
      "\ufeff---\r\ntitle: x\r\nproject-docs: repo-to-vault\r\n---\r\nBody\r\n",
    );
  });

  it("replaces an empty value and a multi-line value", () => {
    expect(setRule("---\nproject-docs:\nb: 1\n---\n", "sync")).toBe(
      "---\nproject-docs: sync\nb: 1\n---\n",
    );
    expect(setRule("---\nproject-docs:\n  - a\n  - b\nc: 2\n---\n", "private")).toBe(
      "---\nproject-docs: private\nc: 2\n---\n",
    );
  });

  it("appends to an empty block and to a block without a final line break", () => {
    expect(setRule("---\n---\nBody", "private")).toBe("---\nproject-docs: private\n---\nBody");
  });

  it("round-trips: setting then reading gives the rule back", () => {
    for (const rule of ["sync", "repo-to-vault", "repo-only", "private"] as const) {
      expect(readRule(setRule("---\ntitle: x\n---\n", rule))).toBe(rule);
    }
  });

  it("refuses to edit frontmatter that isn't valid YAML", () => {
    expect(() => setRule("---\na: : b\n  c\n---\n", "sync")).toThrow(FrontmatterError);
  });
});

describe("setProperties and readProperty", () => {
  it("writes link-note properties, quoting Windows paths literally", () => {
    const text = setProperties("---\ntitle: My repo\n---\nNotes\n", {
      "project-docs-id": "pd_3f2c9a1e-7b4d",
      "project-docs-repo": "\\\\wsl.localhost\\Ubuntu\\home\\me\\repo",
    });
    expect(text).toBe(
      "---\ntitle: My repo\nproject-docs-id: pd_3f2c9a1e-7b4d\n" +
        "project-docs-repo: '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo'\n---\nNotes\n",
    );
    expect(readProperty(text, "project-docs-repo")).toEqual({
      kind: "scalar",
      value: "\\\\wsl.localhost\\Ubuntu\\home\\me\\repo",
    });
  });

  it("returns the text unchanged when there's nothing to set", () => {
    expect(setProperties("x", {})).toBe("x");
  });

  it("reads absent, scalar and structured values", () => {
    const text = "---\na: 1\nb: [x]\n---\n";
    expect(readProperty(text, "a")).toEqual({ kind: "scalar", value: 1 });
    expect(readProperty(text, "b")).toEqual({ kind: "other" });
    expect(readProperty(text, "c")).toEqual({ kind: "absent" });
    expect(readProperty("no block", "a")).toEqual({ kind: "absent" });
    expect(readProperty("---\na: : b\n  c\n---\n", "a")).toEqual({ kind: "invalid-yaml" });
  });
});

describe("removeProperties", () => {
  it("removes properties and their lines, leaving the rest byte-identical", () => {
    const text =
      "---\ntitle: x\r\nproject-docs-id: pd_1\r\ntags:\r\n  - a\r\nuid: pd_1\r\n---\r\nBody\r\n";
    expect(removeProperties(text, ["project-docs-id", "uid", "absent"])).toBe(
      "---\ntitle: x\r\ntags:\r\n  - a\r\n---\r\nBody\r\n",
    );
  });

  it("leaves a file without frontmatter alone", () => {
    expect(removeProperties("Body", ["uid"])).toBe("Body");
  });

  it("removes a property on the block's last line, without a final line break", () => {
    expect(removeProperties("---\na: 1\nb: 2---\n", ["b"])).toBe("---\na: 1\nb: 2---\n");
    expect(removeProperties("---\na: 1\nb: 2\n---\n", ["b"])).toBe("---\na: 1\n---\n");
  });
});

describe("yamlScalar", () => {
  it("writes plain values plain, and quotes anything YAML would misread", () => {
    expect(yamlScalar("private")).toBe("private");
    expect(yamlScalar("Projects/my-repo")).toBe("Projects/my-repo");
    expect(yamlScalar("true")).toBe("'true'");
    expect(yamlScalar("12")).toBe("'12'");
    expect(yamlScalar("C:\\Users\\me")).toBe("'C:\\Users\\me'");
    expect(yamlScalar("it's")).toBe("'it''s'");
    expect(yamlScalar("")).toBe("''");
  });
});
