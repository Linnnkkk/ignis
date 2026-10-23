import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import vm from "node:vm";
import { build } from "esbuild";
const require = createRequire(import.meta.url);
const { parseNote, LIMITS } = require("./metadata.js");
const codes = (note) => note.warnings.map((warning) => warning.code);

describe("bounded read-only note metadata", () => {
  it("parses YAML types, nested properties, Unicode and merged unique tags", () => {
    const note = parseNote('---\ntitle: "  My note  "\ntags: [project/sub, "#中文/子类", project/sub]\npublished: true\ncount: 12\ndate: 2026-10-22\ncustom:\n  items: [one, two]\n---\n# Heading\n#body #中文/子类', "folder/file.md");
    expect(note.title).toBe("My note");
    expect(note.tags).toEqual(["project/sub", "中文/子类", "body"]);
    expect(note.properties).toMatchObject({ published: true, count: 12, date: "2026-10-22", custom: { items: ["one", "two"] } });
    expect(note.hasFrontmatter).toBe(true);
  });

  it("supports block YAML lists and scalar tag strings", () => {
    expect(parseNote("---\ntags:\n - one\n - two/three\n---").tags).toEqual(["one", "two/three"]);
    expect(parseNote("---\ntags: one, two/three # comment\n---").tags).toEqual(["one", "two/three"]);
  });

  it("supports BOM, CRLF, multiline properties and ... closing delimiter", () => {
    const note = parseNote("\uFEFF---\r\ntitle: >-\r\n  multi\r\n  line\r\n...\r\n#body", "a.md");
    expect(note.title).toBe("multi line");
    expect(note.tags).toEqual(["body"]);
  });

  it("falls back from frontmatter to first ATX H1 then filename", () => {
    expect(parseNote("## Other\n# First ##\n# Second", "a.md").title).toBe("First");
    expect(parseNote("text", "folder\\name.MD").title).toBe("name");
    expect(parseNote("x").title).toBe("");
  });

  it("does not confuse code blocks, inline code, comments and headings with tags/links", () => {
    const note = parseNote('```md\n#bad [[bad]]\n```\n~~~\n#bad2\n~~~\n    #indented [[bad]]\n`#inline [[bad]]` ``a ` #nested [[bad]]``\n<!-- #comment [[bad]] -->\n%% #hidden\n[[bad]] %%\n# Heading\n#good #parent/child');
    expect(note.tags).toEqual(["good", "parent/child"]);
    expect(note.links).toEqual([]);
    expect(note.title).toBe("Heading");
  });

  it("ignores code with varying fence lengths and multiline inline code", () => {
    const note = parseNote('````\n```\n#hidden [[bad]]\n````\n`a\n#hidden2 [[bad2]]\nb`\n#visible');
    expect(note.tags).toEqual(["visible"]);
    expect(note.links).toEqual([]);
  });

  it("does not match escaped tags, numeric-only tags, URL anchors or malformed nested names", () => {
    const note = parseNote('\\#escaped word#not https://host/#fragment #123 #a//b #trailing/ #real #a-b #123_4');
    expect(note.tags).toEqual(["real", "a-b", "123_4"]);
  });

  it("parses wiki links/embeds, heading/block refs, aliases without resolving targets", () => {
    const note = parseNote('[[Folder/Note#Heading|Alias]] ![[image.png|200]] [[#^block]] [[../Other]]');
    expect(note.links).toEqual([
      { type: "wiki", embed: false, target: "Folder/Note#Heading", path: "Folder/Note", subpath: "Heading", external: false, alias: "Alias" },
      { type: "wiki", embed: true, target: "image.png", path: "image.png", subpath: null, external: false, alias: "200" },
      { type: "wiki", embed: false, target: "#^block", path: "", subpath: "^block", external: false, alias: null },
      { type: "wiki", embed: false, target: "../Other", path: "../Other", subpath: null, external: false, alias: null },
    ]);
  });

  it("parses Markdown inline links/images, balanced destinations, titles, angles, queries and schemes", () => {
    const note = parseNote('[Label](folder/a(b).md#H "Title") ![alt](<some image.png>) [web](https://example.com/a?q=x#frag) [mail](mailto:a@b.c)');
    expect(note.links.map((link) => [link.target, link.embed, link.external])).toEqual([
      ["folder/a(b).md#H", false, false], ["some image.png", true, false],
      ["https://example.com/a?q=x#frag", false, true], ["mailto:a@b.c", false, true],
    ]);
    expect(note.links[2].path).toBe("https://example.com/a");
    expect(note.tags).toEqual([]);
  });

  it("does not extract tags inside link aliases or destinations or escaped links", () => {
    const note = parseNote('[[note#heading|#alias]] [#label](a.md#fragment) \\[[escaped]] \\[escaped](a.md) #real');
    expect(note.tags).toEqual(["real"]);
    expect(note.links).toHaveLength(2);
  });

  it("reports malformed YAML and continues parsing body without leaking frontmatter", () => {
    const note = parseNote('---\nsecret: [broken\ntags: fake\n---\n#body [[real]]');
    expect(note.properties).toEqual({});
    expect(note.tags).toEqual(["body"]);
    expect(codes(note)).toContain("frontmatter_invalid");
    expect(JSON.stringify(note.warnings)).not.toContain("secret");
  });

  it.each(['- a\n- b', '42', 'x: 1\nx: 2', 'x: !!js/function "function(){}"', 'x: &a [*a]', '__proto__: { polluted: true }', 'nested: { constructor: bad }', 'x: .inf'])("rejects unsupported/unsafe YAML %s", (source) => {
    const note = parseNote(`---\n${source}\n---\n#body`);
    expect(note.properties).toEqual({});
    expect(codes(note)).toContain("frontmatter_invalid");
    expect({}.polluted).toBeUndefined();
  });

  it("does not expand YAML alias graphs", () => {
    const note = parseNote('---\na: &a [x,x,x]\nb: [*a,*a,*a]\n---');
    expect(codes(note)).toContain("frontmatter_invalid");
  });

  it("bounds YAML depth and node counts before construction", () => {
    for (const source of [`x: ${"[".repeat(1000)}0${"]".repeat(1000)}`, `x: [${Array(5000).fill("x").join(",")}]`]) {
      expect(codes(parseNote(`---\n${source}\n---`))).toContain("frontmatter_invalid");
    }
  });

  it("bounds note/frontmatter sizes and refuses unclosed frontmatter", () => {
    const large = parseNote("x".repeat(LIMITS.content + 1), "file.md");
    expect(codes(large)).toContain("content_limit");
    expect(large.title).toBe("file");
    const fm = parseNote(`---\nx: ${"a".repeat(LIMITS.frontmatter)}\n---\n#body`);
    expect(codes(fm)).toContain("frontmatter_limit");
    expect(fm.tags).toEqual(["body"]);
    const unclosed = parseNote("---\ntags: fake\n#fake [[fake]]");
    expect(codes(unclosed)).toContain("frontmatter_unclosed");
    expect(unclosed.tags).toEqual([]);
    expect(unclosed.links).toEqual([]);
  });

  it("bounds emitted entries and validates tag types", () => {
    const note = parseNote(Array.from({ length: LIMITS.entries + 10 }, (_, i) => `#tag${i} [[note${i}]]`).join(" "));
    expect(note.tags).toHaveLength(LIMITS.entries);
    expect(note.links).toHaveLength(LIMITS.entries);
    expect(codes(note)).toContain("entries_limit");
    const bad = parseNote('---\ntags: [one, 42, null, {}, "bad tag", "a//b"]\n---');
    expect(bad.tags).toEqual(["one"]);
    expect(codes(bad)).toContain("tags_invalid");
  });

  it("bounds malformed link candidate scans", () => {
    const note = parseNote("[".repeat(5000));
    expect(note.links).toEqual([]);
    expect(codes(note)).toContain("link_scan_limit");
  });

  it("explicitly warns about unsupported syntax and never resolves references or targets", () => {
    const note = parseNote('[label][ref]\n[ref]: secret.md\n<https://example.com>');
    expect(note.links).toEqual([]);
    expect(codes(note)).toContain("limited_parser");
    expect(() => parseNote(null)).toThrow(TypeError);
    expect(JSON.parse(JSON.stringify(note))).toEqual(note);
  });

  it("bundles with existing esbuild and runs CommonJS output with YAML included (no files written)", async () => {
    const result = await build({ entryPoints: [new URL("./metadata.js", import.meta.url).pathname], bundle: true, write: false, platform: "node", format: "cjs", target: "node18", metafile: true });
    expect(Object.keys(result.metafile.inputs).some((file) => file.includes("js-yaml"))).toBe(true);
    const sandbox = { module: { exports: {} }, exports: {} };
    vm.runInNewContext(result.outputFiles[0].text, sandbox, { timeout: 1000 });
    expect(sandbox.module.exports.parseNote('---\ntags: [bundled]\n---').tags).toEqual(["bundled"]);
  });
});
