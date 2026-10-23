const yaml = require("js-yaml");

// Deliberately a bounded metadata extractor, NOT Obsidian's Markdown renderer/cache.
// No filesystem/network access, target resolution, plugin execution or HTML rendering.
const LIMITS = Object.freeze({ content: 1024 * 1024, frontmatter: 64 * 1024, depth: 24, nodes: 4096, entries: 2048, target: 4096 });
const TAG = /^[\p{L}\p{N}_-]+(?:\/[\p{L}\p{N}_-]+)*$/u;
const LETTER = /[\p{L}_-]/u;
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

function escaped(text, index) {
  let count = 0;
  while (index > 0 && text[--index] === "\\") count++;
  return count % 2 === 1;
}

function cleanYaml(value, depth = 0) {
  if (depth > LIMITS.depth) throw new Error("Property nesting limit exceeded");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Non-finite property value");
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => cleanYaml(item, depth + 1));
  if (value && typeof value === "object") {
    const result = {};
    for (const [key, item] of Object.entries(value)) {
      if (["__proto__", "constructor", "prototype"].includes(key)) throw new Error("Unsafe property key");
      result[key] = cleanYaml(item, depth + 1);
    }
    return result;
  }
  throw new Error("Unsupported property value");
}

function frontmatter(text, warn) {
  const opening = /^(?:\uFEFF)?---[ \t]*\r?\n/.exec(text);
  if (!opening) return { properties: {}, body: text, present: false };
  const closing = /^(?:---|\.\.\.)[ \t]*\r?$/gm;
  closing.lastIndex = opening[0].length;
  const end = closing.exec(text);
  if (!end) {
    warn("frontmatter_unclosed", "Unclosed frontmatter; no body metadata extracted.");
    return { properties: {}, body: "", present: true };
  }
  const source = text.slice(opening[0].length, end.index);
  const body = text.slice(end.index + end[0].length).replace(/^\r?\n/, "");
  if (source.length > LIMITS.frontmatter) {
    warn("frontmatter_limit", "Frontmatter exceeds 64 Ki UTF-16 code units; properties omitted.");
    return { properties: {}, body, present: true };
  }
  let depth = 0;
  let nodes = 0;
  try {
    const properties = yaml.load(source, {
      schema: yaml.JSON_SCHEMA,
      // Listener runs during composition, before an attacker can force deep recursion.
      listener(event, state) {
        if (event === "open") {
          if (++depth > LIMITS.depth || ++nodes > LIMITS.nodes) throw new Error("YAML complexity limit exceeded");
        } else {
          depth--;
          // Aliases/anchors (including merge graphs and cycles) are intentionally unsupported.
          if (state.anchor !== null || Object.keys(state.anchorMap).length) throw new Error("YAML anchors and aliases are unsupported");
        }
      },
      onWarning() { throw new Error("YAML parser warning"); },
    });
    if (properties === undefined || properties === null) return { properties: {}, body, present: true };
    if (typeof properties !== "object" || Array.isArray(properties)) throw new Error("Frontmatter must be a mapping");
    return { properties: cleanYaml(properties), body, present: true };
  } catch (error) {
    // Do not echo YAML source or parser diagnostics (which may contain private note content).
    warn("frontmatter_invalid", `Frontmatter omitted: ${error instanceof Error && /^(YAML complexity|YAML anchors|Unsafe property|Property nesting|Frontmatter must|Non-finite)/.test(error.message) ? error.message : "invalid or unsupported YAML"}.`);
    return { properties: {}, body, present: true };
  }
}

function maskBlocks(body) {
  const lines = body.split("\n");
  let fence = null;
  let comment = null;
  return lines.map((line) => {
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (match && match[1][0] === fence.char && match[1].length >= fence.length && !match[2].trim()) fence = null;
      return " ".repeat(line.length);
    }
    if (match && !(match[1][0] === "`" && match[2].includes("`"))) {
      fence = { char: match[1][0], length: match[1].length };
      return " ".repeat(line.length);
    }
    if (/^(?: {4}|\t)/.test(line)) return " ".repeat(line.length);
    let result = "";
    for (let i = 0; i < line.length;) {
      if (comment) {
        const end = line.indexOf(comment, i);
        if (end < 0) return result + " ".repeat(line.length - i);
        result += " ".repeat(end + comment.length - i);
        i = end + comment.length;
        comment = null;
      } else if (line.startsWith("<!--", i) || line.startsWith("%%", i)) {
        comment = line.startsWith("<!--", i) ? "-->" : "%%";
        const length = comment === "-->" ? 4 : 2;
        result += " ".repeat(length);
        i += length;
      } else result += line[i++];
    }
    return result;
  }).join("\n");
}

function maskInline(text) {
  const runs = [...text.matchAll(/`+/g)];
  const next = new Map();
  const pairs = new Map();
  for (let i = runs.length - 1; i >= 0; i--) {
    const run = runs[i];
    if (next.has(run[0].length)) pairs.set(run.index, next.get(run[0].length));
    next.set(run[0].length, run);
  }
  let end = 0;
  const chunks = [];
  for (const run of runs) {
    if (run.index < end || escaped(text, run.index)) continue;
    const close = pairs.get(run.index);
    if (!close) continue;
    chunks.push(text.slice(end, run.index));
    end = close.index + close[0].length;
    chunks.push(text.slice(run.index, end).replace(/[^\n]/g, " "));
  }
  return chunks.join("") + text.slice(end);
}

function linkFields(target) {
  const hash = target.indexOf("#");
  const query = target.indexOf("?");
  const stop = hash < 0 ? target.length : hash;
  return {
    target,
    path: target.slice(0, query >= 0 && query < stop ? query : stop),
    subpath: hash >= 0 ? target.slice(hash + 1) : null,
    external: /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(target),
  };
}

// Simple inline Markdown links, balanced parentheses and optional quoted titles.
// Reference links/autolinks/HTML are not resolved by this extractor.
function markdownLink(text, start) {
  let i = start + 1;
  let brackets = 1;
  for (; i < text.length && i - start <= LIMITS.target; i++) {
    if (text[i] === "\\") { i++; continue; }
    if (text[i] === "[") brackets++;
    if (text[i] === "]" && --brackets === 0) break;
    if (text[i] === "\n") return null;
  }
  if (brackets || text[i + 1] !== "(") return null;
  const label = text.slice(start + 1, i);
  i += 2;
  while (/[ \t]/.test(text[i] || "\0")) i++;
  let target;
  if (text[i] === "<") {
    const relativeEnd = text.slice(i + 1, start + LIMITS.target + 1).indexOf(">");
    const end = relativeEnd < 0 ? -1 : i + 1 + relativeEnd;
    if (end < 0 || end - start > LIMITS.target || /\n/.test(text.slice(i, end))) return null;
    target = text.slice(i + 1, end);
    i = end + 1;
  } else {
    const begin = i;
    let level = 0;
    for (; i < text.length && i - start <= LIMITS.target; i++) {
      if (text[i] === "\\") { i++; continue; }
      if (text[i] === "(") level++;
      if (text[i] === ")") {
        if (!level) break;
        level--;
      }
      if (/\s/.test(text[i])) break;
    }
    if (level) return null;
    target = text.slice(begin, i);
  }
  while (/[ \t]/.test(text[i] || "\0")) i++;
  if (text[i] === '"' || text[i] === "'") {
    const quote = text[i++];
    while (i < text.length && i - start <= LIMITS.target && (text[i] !== quote || escaped(text, i)) && text[i] !== "\n") i++;
    if (text[i++] !== quote) return null;
    while (/[ \t]/.test(text[i] || "\0")) i++;
  }
  if (text[i] !== ")" || i - start > LIMITS.target) return null;
  return { end: i + 1, target: target.replace(/\\([\\()[\]<> ])/g, "$1"), alias: label };
}

/**
 * parseNote(content, path) -> JSON-safe metadata, synchronously, without I/O.
 * title: frontmatter title > first ATX H1 > filename; tags: unique, no leading #,
 * original case, nested slash names kept (no implicit parent tags).
 * links: [{type:'wiki'|'markdown', embed, target, path, subpath, external, alias}].
 * properties: JSON_SCHEMA YAML mapping (dates remain strings); warnings: [{code,message}].
 * No full CommonMark/Obsidian compatibility: reference links, autolinks, HTML,
 * plugin syntax, setext titles and blockquote/list-contained code fences not supported.
 * Limits use UTF-16 units, not bytes; caller remains responsible for file byte limits.
 */
function parseNote(content, path = "") {
  if (typeof content !== "string" || typeof path !== "string") throw new TypeError("content and path must be strings");
  const warnings = [];
  const warn = (code, message) => {
    if (!warnings.some((entry) => entry.code === code)) warnings.push({ code, message });
  };
  warn("limited_parser", "Bounded subset, not full Obsidian/CommonMark compatibility; no target resolution, reference links, autolinks, HTML or plugin syntax.");
  const fallback = path.replace(/\\/g, "/").split("/").pop().replace(/\.md$/i, "");
  if (content.length > LIMITS.content) {
    warn("content_limit", "Note exceeds 1 Mi UTF-16 code units; metadata omitted (not partially parsed).");
    return { path, title: fallback, tags: [], properties: {}, links: [], hasFrontmatter: false, warnings };
  }
  const parsed = frontmatter(content, warn);
  const text = maskInline(maskBlocks(parsed.body));
  const tags = [];
  const tagSet = new Set();
  const addTag = (value) => {
    if (typeof value !== "string") { warn("tags_invalid", "Non-string or invalid frontmatter tags ignored."); return; }
    const tag = value.replace(/^#/, "");
    if (!TAG.test(tag) || !LETTER.test(tag)) { warn("tags_invalid", "Non-string or invalid frontmatter tags ignored."); return; }
    if (!tagSet.has(tag)) {
      if (tags.length >= LIMITS.entries) { warn("entries_limit", "Tag/link entry limit reached; remaining entries omitted."); return; }
      tags.push(tag);
      tagSet.add(tag);
    }
  };
  if (own(parsed.properties, "tags")) {
    const value = parsed.properties.tags;
    if (Array.isArray(value)) value.forEach(addTag);
    else if (typeof value === "string") value.split(/[,\s]+/).filter(Boolean).forEach(addTag);
    else warn("tags_invalid", "tags must be a string or string list.");
  }
  const links = [];
  let linkAttempts = 0;
  for (let i = 0; i < text.length; i++) {
    if (!"![#".includes(text[i])) continue;
    if (escaped(text, i)) continue;
    const embed = text[i] === "!" && !escaped(text, i);
    const start = embed ? i + 1 : i;
    if (text[start] === "[" && ++linkAttempts <= LIMITS.entries * 2) {
      let link;
      if (text[start + 1] === "[") {
        const relativeEnd = text.slice(start + 2, start + LIMITS.target + 2).indexOf("]]");
        const end = relativeEnd < 0 ? -1 : start + 2 + relativeEnd;
        if (end >= 0 && end - start <= LIMITS.target && !text.slice(start, end).includes("\n")) {
          const inner = text.slice(start + 2, end);
          const pipe = inner.indexOf("|");
          link = { type: "wiki", end: end + 2, target: (pipe < 0 ? inner : inner.slice(0, pipe)).trim(), alias: pipe < 0 ? null : inner.slice(pipe + 1) };
        }
      } else {
        const match = markdownLink(text, start);
        if (match) link = { type: "markdown", ...match };
      }
      if (link) {
        if (links.length < LIMITS.entries) links.push({ type: link.type, embed, ...linkFields(link.target), alias: link.alias });
        else warn("entries_limit", "Tag/link entry limit reached; remaining entries omitted.");
        i = link.end - 1;
        continue;
      }
    }
    if (linkAttempts > LIMITS.entries * 2) warn("link_scan_limit", "Link candidate limit reached; further links omitted.");
    if (text[i] === "#" && (i === 0 || !/[\p{L}\p{N}_/#\\:]/u.test(text[i - 1]))) {
      const match = /^[\p{L}\p{N}_/-]+/u.exec(text.slice(i + 1));
      if (match) {
        const tag = match[0];
        if (TAG.test(tag) && LETTER.test(tag)) addTag(tag);
        i += tag.length;
      }
    }
  }
  const heading = /^ {0,3}#[ \t]+(.+)$/m.exec(text);
  const title = typeof parsed.properties.title === "string" && parsed.properties.title.trim() ? parsed.properties.title.trim() : heading ? heading[1].replace(/[ \t]+#+[ \t]*$/, "").trim() : fallback;
  return { path, title, tags, properties: parsed.properties, links, hasFrontmatter: parsed.present, warnings };
}

module.exports = { parseNote, LIMITS };
