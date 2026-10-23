// Bounded read-only Obsidian vault query layer. All I/O goes through owner policy/path guards.
function createQueries({ scan, read, parseNote }) {
  function page(items, params, extra = {}) {
    const offset = params.offset ?? 0;
    const limit = params.limit ?? 50;
    if (!Number.isInteger(offset) || offset < 0 || offset > 10000 || !Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw Object.assign(new Error('offset/limit out of range'), { code: 'BAD_REQUEST' });
    }
    return { items: items.slice(offset, offset + limit), total: items.length,
      nextOffset: offset + limit < items.length ? offset + limit : null, ...extra };
  }
  function notes(params) {
    return scan(params).map(item => ({ ...item, ...parseNote(item.content, item.path) }));
  }
  function metadata(params) {
    const note = read(params);
    return { path: note.path, revision: note.revision, ...parseNote(note.content, note.path), bytes: Buffer.byteLength(note.content) };
  }
  function query(params) {
    page([], params);
    const fields = ['query', 'title', 'tag', 'pathPrefix'];
    for (const key of fields) if (params[key] !== undefined && (typeof params[key] !== 'string' || params[key].length > 256)) {
      throw Object.assign(new Error(`Invalid ${key}`), { code: 'BAD_REQUEST' });
    }
    const needle = (params.query || '').toLocaleLowerCase();
    const title = (params.title || '').toLocaleLowerCase();
    const tag = (params.tag || '').replace(/^#/, '');
    const prefix = params.pathPrefix || '';
    const result = notes(params).filter(n => (!needle || n.content.toLocaleLowerCase().includes(needle)) &&
      (!title || n.title.toLocaleLowerCase().includes(title) || n.path.toLocaleLowerCase().includes(title)) &&
      (!tag || n.tags.includes(tag)) && (!prefix || n.path === prefix || n.path.startsWith(prefix.replace(/\/$/, '') + '/')))
      .map(({ content, ...n }) => ({ ...n, excerpt: needle ? content.slice(Math.max(0, content.toLocaleLowerCase().indexOf(needle) - 60), content.toLocaleLowerCase().indexOf(needle) + needle.length + 160) : '' }));
    return page(result, params, { truncated: false, tagMatch: 'exact-case-sensitive', searchSyntax: 'literal' });
  }
  function tags(params) {
    page([], params);
    const counts = new Map();
    for (const n of notes(params)) for (const tag of new Set(n.tags)) counts.set(tag, (counts.get(tag) || 0) + 1);
    return page([...counts].sort(([a], [b]) => a.localeCompare(b)).map(([tag, count]) => ({ tag, count })), params);
  }
  function links(params) {
    const note = metadata(params);
    return { path: note.path, links: note.links, warnings: note.warnings };
  }
  function backlinks(params) {
    const target = read(params).path;
    const stem = target.replace(/\.md$/, '');
    const basename = stem.split('/').at(-1);
    const all = notes(params);
    const offset = params.offset ?? 0;
    const limit = params.limit ?? 50;
    page([], params); // Validate before scanning.
    const matches = [];
    let total = 0;
    const basenameCounts = new Map();
    for (const note of all) {
      const name = note.path.replace(/\.md$/, '').split('/').at(-1);
      basenameCounts.set(name, (basenameCounts.get(name) || 0) + 1);
    }
    let visitedLinks = 0;
    for (const note of all) {
      for (const link of note.links) {
        if (++visitedLinks > 10000) throw Object.assign(new Error('Backlink scan budget exceeded'), { code: 'LIMIT_EXCEEDED' });
        if (link.external || !link.path) continue;
        let decoded;
        try { decoded = decodeURIComponent(link.path); } catch { continue; }
        const posix = require('path').posix;
        const normalized = decoded.replace(/\.md$/, '');
        const relative = posix.normalize(posix.join(posix.dirname(note.path), normalized));
        const rootMatch = normalized === stem;
        const relativeMatch = relative === stem;
        const shortMatch = link.type === 'wiki' && !normalized.includes('/') && normalized === basename;
        if (rootMatch || relativeMatch || shortMatch) {
          if (total >= offset && matches.length < limit) matches.push({ path: note.path, link,
            resolution: shortMatch && basenameCounts.get(basename) > 1 ? 'ambiguous-candidate' : 'candidate' });
          total++;
        }
      }
    }
    return { items: matches, total, nextOffset: offset + limit < total ? offset + limit : null,
      warnings: ['Candidate backlinks only; not full Obsidian link resolution. Ambiguous basenames are explicitly marked.'] };
  }
  function outline(params) {
    const note = read(params);
    const headings = [];
    let fence = '';
    let frontmatter = false;
    const lines = note.content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].replace(/\r$/, '');
      if (i === 0 && line === '---') { frontmatter = true; continue; }
      if (frontmatter) { if (line === '---' || line === '...') frontmatter = false; continue; }
      const marker = line.match(/^ {0,3}(`{3,}|~{3,})/);
      if (marker) {
        if (!fence) fence = marker[1];
        else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = '';
        continue;
      }
      if (fence) continue;
      const heading = line.match(/^ {0,3}(#{1,6})[ \t]+(.+?)\s*#*\s*$/);
      if (heading) {
        if (headings.length >= 500) throw Object.assign(new Error('Heading budget exceeded'), { code: 'LIMIT_EXCEEDED' });
        headings.push({ line: i + 1, level: heading[1].length, title: heading[2] });
      }
    }
    return { path: note.path, revision: note.revision, lineCount: lines.length, headings,
      warnings: ['ATX heading outline only; Setext/HTML/plugin headings are not resolved. Line numbers are 1-based.'] };
  }
  function readLines(params) {
    const note = read(params);
    const startLine = params.startLine ?? 1;
    const lineCount = params.lineCount ?? 100;
    if (!Number.isInteger(startLine) || startLine < 1 || !Number.isInteger(lineCount) || lineCount < 1 || lineCount > 300) throw Object.assign(new Error('Invalid line range'), { code: 'BAD_REQUEST' });
    const lines = note.content.split('\n');
    if (startLine > lines.length) throw Object.assign(new Error('Start line exceeds note length'), { code: 'BAD_REQUEST' });
    const selected = lines.slice(startLine - 1, startLine - 1 + lineCount);
    return { path: note.path, revision: note.revision, startLine, endLine: startLine + selected.length - 1,
      totalLines: lines.length, content: selected.join('\n'), truncated: startLine - 1 + selected.length < lines.length,
      revisionScope: 'entire-note', partial: true };
  }
  function tasks(params) {
    page([], params);
    if (params.pathPrefix !== undefined && (typeof params.pathPrefix !== 'string' || params.pathPrefix.length > 256)) throw Object.assign(new Error('Invalid pathPrefix'), { code: 'BAD_REQUEST' });
    if (params.status !== undefined && !['open', 'done', 'all'].includes(params.status)) throw Object.assign(new Error('Invalid task status'), { code: 'BAD_REQUEST' });
    const items = [];
    for (const note of notes(params)) {
      if (params.pathPrefix && !(note.path === params.pathPrefix || note.path.startsWith(params.pathPrefix.replace(/\/$/, '') + '/'))) continue;
      let fence = '';
      let frontmatter = false;
      const lines = note.content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].replace(/\r$/, '');
        if (i === 0 && line === '---') { frontmatter = true; continue; }
        if (frontmatter) { if (line === '---' || line === '...') frontmatter = false; continue; }
        const marker = line.match(/^ {0,3}(`{3,}|~{3,})/);
        if (marker) { if (!fence) fence = marker[1]; else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = ''; continue; }
        if (fence) continue;
        const match = line.match(/^ {0,3}(?:[-*+]|\d+[.)])[ \t]+\[([ xX])\][ \t]+(.+)$/);
        if (!match) continue;
        const status = match[1] === ' ' ? 'open' : 'done';
        if (params.status && params.status !== 'all' && params.status !== status) continue;
        if (items.length >= 2000) throw Object.assign(new Error('Task result budget exceeded'), { code: 'LIMIT_EXCEEDED' });
        items.push({ path: note.path, line: i + 1, status, text: match[2], sourceLine: line, revision: note.revision });
      }
    }
    return page(items, params, { warnings: ['Standard Markdown checkboxes only; custom Tasks-plugin states/dates and nested container syntax are not interpreted. To change status, use unique sourceLine patch with the returned whole-note revision.'] });
  }
  return { metadata, query, tags, links, backlinks, outline, readLines, tasks };
}
module.exports = { createQueries };
