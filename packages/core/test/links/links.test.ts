import { describe, expect, it } from "vitest";
import {
  convertWikilinks,
  createResolver,
  findLinks,
  findMarkdownLinks,
  findWikiLinks,
  headingAnchor,
  linkTargets,
  protectedRanges,
  type LinkResolver,
} from "../../src/links/index.js";

const listing = {
  projectFolder: "Projects/repo",
  files: [
    "Projects/repo/Setup Guide.md",
    "Projects/repo/diagram.png",
    "Projects/repo/guides/Install.md",
    "Projects/repo/guides/Note.md",
    "Projects/repo/private/server-notes.md",
    "Projects/repo/Note.md",
    "Journal/2026-10-22.md",
    "Clients/Note.md",
  ],
};
const resolver: LinkResolver = createResolver(listing);
const convert = (text: string, from = "index.md", keep = false) =>
  convertWikilinks(text, from, resolver, { keepLinksAsWritten: keep });

describe("finding links", () => {
  it("parses wikilink parts", () => {
    const [link] = findWikiLinks("see [[folder/Note#Heading|shown]] here");
    expect(link).toMatchObject({
      embed: false,
      target: "folder/Note",
      heading: "Heading",
      alias: "shown",
      start: 4,
      raw: "[[folder/Note#Heading|shown]]",
    });
    expect(findWikiLinks("![[img.png]] [[Note#^abc123]]")).toMatchObject([
      { embed: true, target: "img.png" },
      { embed: false, target: "Note", block: "abc123" },
    ]);
  });

  it("ignores links inside code, frontmatter and HTML", () => {
    const text = [
      "---",
      "related: '[[In Frontmatter]]'",
      "---",
      "`[[Inline Code]]` and [[Real]]",
      "",
      "```",
      "[[Fenced]]",
      "```",
      "",
      "<!-- [[In A Comment]] -->",
      "",
    ].join("\n");
    expect(findWikiLinks(text).map((l) => l.target)).toEqual(["Real"]);
    expect(protectedRanges(text).length).toBeGreaterThanOrEqual(4);
  });

  it("finds relative Markdown links and images, decoded, without fragments", () => {
    const text =
      "[a](Setup%20Guide.md#install) ![b](diagram.png) [c](https://example.com) [d](#local) " +
      "[e](/abs.md) [f](mailto:x@y.z)\n\n[ref]: guides/Install.md\n";
    expect(findMarkdownLinks(text).map((l) => [l.path, l.embed])).toEqual([
      ["Setup Guide.md", false],
      ["diagram.png", true],
      ["guides/Install.md", false],
    ]);
  });

  it("keeps a destination that isn't valid percent-encoding as written", () => {
    expect(findMarkdownLinks("[a](100%.md)")[0]?.path).toBe("100%.md");
  });

  it("lists all links in document order", () => {
    expect(findLinks("[[B]] [a](A.md) [[C]]").map((l) => l.kind)).toEqual([
      "wikilink",
      "markdown",
      "wikilink",
    ]);
  });
});

describe("converting wikilinks (REQ-12)", () => {
  it("converts an aliased wikilink to a relative Markdown link (REQ-12.1)", () => {
    expect(convert("See [[Setup Guide|setup]].").text).toBe("See [setup](Setup%20Guide.md).");
  });

  it("converts an image embed (REQ-12.2)", () => {
    expect(convert("![[diagram.png]]").text).toBe("![diagram.png](diagram.png)");
  });

  it("leaves a block reference as written and reports it (REQ-12.3)", () => {
    const result = convert("[[Note#^abc123]]");
    expect(result.text).toBe("[[Note#^abc123]]");
    expect(result.unconvertible[0]?.reason).toContain("block reference");
  });

  it("changes nothing with keep links as written (REQ-12.4)", () => {
    const text = "[[Setup Guide|setup]] ![[diagram.png]]";
    expect(convert(text, "index.md", true)).toEqual({ text, converted: 0, unconvertible: [] });
  });

  it("maps heading anchors to GitHub's form and keeps the text as written", () => {
    expect(convert("[[Setup Guide#Install on Windows!]]").text).toBe(
      "[Setup Guide#Install on Windows!](Setup%20Guide.md#install-on-windows)",
    );
    expect(convert("[[#Next Steps]]").text).toBe("[Next Steps](#next-steps)");
    expect(headingAnchor("  Café & Bar_2 ")).toBe("café--bar_2");
  });

  it("writes paths relative to the linking note", () => {
    expect(convert("[[Install]]", "guides/Note.md").text).toBe("[Install](Install.md)");
    expect(convert("[[Setup Guide]]", "guides/Note.md").text).toBe(
      "[Setup Guide](../Setup%20Guide.md)",
    );
  });

  it("prefers the file in the linking note's folder when names clash", () => {
    expect(convert("[[Note]]", "guides/Install.md").text).toBe("[Note](Note.md)");
    expect(convert("[[guides/Note]]").text).toBe("[guides/Note](guides/Note.md)");
  });

  it("leaves links outside the project, missing, ambiguous or embedding a note as written", () => {
    const text = "[[2026-10-22]] [[Nowhere]] [[Note]] ![[Setup Guide]]";
    const result = convert(text, "other/x.md");
    expect(result.text).toBe(text);
    expect(result.unconvertible.map((u) => u.reason)).toEqual([
      "the target is outside the project folder",
      "the target doesn't exist",
      expect.stringContaining("several files match"),
      "an embedded note has no Markdown equivalent",
    ]);
  });

  it("escapes brackets in link text and converts several links, leaving other text intact", () => {
    const result = convert("A [[Setup Guide|see [docs]]] then [[guides/Install|install]] end");
    // A bracket inside the alias stops it being a wikilink, so only the second link converts.
    expect(result.converted).toBe(1);
    expect(result.text).toBe("A [[Setup Guide|see [docs]]] then [install](guides/Install.md) end");
    expect(convert("[[Setup Guide|a [b]]]").text).toBe("[[Setup Guide|a [b]]]");
    expect(convert("[[Setup Guide|a\\b]]").text).toBe("[a\\\\b](Setup%20Guide.md)");
  });
});

describe("resolving targets for the guards (REQ-13)", () => {
  it("classifies wikilinks and Markdown links", () => {
    const targets = linkTargets(
      "[[private/server-notes]] [[2026-10-22]] [x](../../Journal/2026-10-22.md) [y](Setup%20Guide) [z](../../../escape.md)",
      "index.md",
      resolver,
    );
    expect(targets.map((t) => t.resolution)).toEqual([
      { where: "inside", key: "private/server-notes.md" },
      { where: "outside", vaultPath: "Journal/2026-10-22.md" },
      { where: "outside", vaultPath: "Journal/2026-10-22.md" },
      { where: "inside", key: "Setup Guide.md" },
      { where: "missing" },
    ]);
  });

  it("resolves at the vault root when the project folder is the root", () => {
    const rootResolver = createResolver({ projectFolder: "", files: ["a.md", "b/c.md"] });
    expect(rootResolver.resolve(findWikiLinks("[[c]]")[0]!, "a.md")).toEqual({
      where: "inside",
      key: "b/c.md",
    });
  });
});
