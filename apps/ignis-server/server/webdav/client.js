// Minimal WebDAV client for the Vitreus remote-vault experiment (1.4.2).
//
// Scope of this first step: read-only directory tree discovery. The output
// mirrors what server/cache/crawl.js produces so a WebDAV backend can later
// replace the local crawler without touching the shim or the fs routes:
//   { tree: { "<relPath>": { type, size, mtime, ctime } }, dirMtimes: { "": mtimeMs } }
//
// Deliberately built on Node's bundled http/https: no new dependency, and the
// embedded arm64 bundle has to stay small.

const http = require("http");
const https = require("https");
const { URL } = require("url");

const DEFAULT_TIMEOUT_MS = 20000;
const DEFAULT_CONCURRENCY = 6;
const MAX_XML_BYTES = 32 * 1024 * 1024;

const PROPFIND_BODY =
  '<?xml version="1.0" encoding="utf-8"?>' +
  '<d:propfind xmlns:d="DAV:"><d:prop>' +
  "<d:resourcetype/><d:getcontentlength/><d:getlastmodified/><d:creationdate/>" +
  "</d:prop></d:propfind>";

class WebdavError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "WebdavError";
    this.status = status || 0;
  }
}

// Keep-alive agents are the single biggest win here: a cold vault crawl issues
// hundreds of PROPFINDs, and a fresh TLS handshake per request would dominate.
const agentPool = new Map();

function agentFor(protocol, insecure) {
  const key = protocol + (insecure ? ":insecure" : "");
  let agent = agentPool.get(key);

  if (!agent) {
    const Agent = protocol === "https:" ? https.Agent : http.Agent;
    agent = new Agent({
      keepAlive: true,
      maxSockets: DEFAULT_CONCURRENCY,
      rejectUnauthorized: !insecure,
    });
    agentPool.set(key, agent);
  }

  return agent;
}

function authHeader(username, password) {
  if (!username) {
    return null;
  }

  return (
    "Basic " + Buffer.from(username + ":" + password, "utf8").toString("base64")
  );
}

function request(method, target, options = {}) {
  const {
    headers = {},
    body = null,
    timeout = DEFAULT_TIMEOUT_MS,
    insecure = false,
    maxBytes = MAX_XML_BYTES,
  } = options;

  return new Promise((resolve, reject) => {
    let url;

    try {
      url = new URL(target);
    } catch (e) {
      reject(new WebdavError("Invalid WebDAV URL"));
      return;
    }

    if (url.protocol !== "http:" && url.protocol !== "https:") {
      reject(new WebdavError("WebDAV URL must use http or https"));
      return;
    }

    const sentHeaders = Object.assign({}, headers);

    if (body !== null) {
      sentHeaders["Content-Length"] = Buffer.byteLength(body);
    }

    const req = httpRequest(url, method, sentHeaders, insecure, timeout, resolve, reject, maxBytes);

    if (req === null) {
      return;
    }

    if (body !== null) {
      req.write(body);
    }

    req.end();
  });
}

function httpRequest(url, method, headers, insecure, timeout, resolve, reject, maxBytes) {
  const transport = url.protocol === "https:" ? https : http;

  let req;

  try {
    req = transport.request(
      {
        method,
        hostname: url.hostname.replace(/^\[|\]$/g, ""),
        port: url.port || undefined,
        path: url.pathname + url.search,
        headers,
        agent: agentFor(url.protocol, insecure),
        rejectUnauthorized: !insecure,
      },
      (res) => {
        const chunks = [];
        let size = 0;
        let settled = false;

        const fail = (err) => {
          if (settled) {
            return;
          }

          settled = true;
          res.destroy();
          reject(err);
        };

        res.on("data", (chunk) => {
          size += chunk.length;

          if (size > maxBytes) {
            fail(new WebdavError("WebDAV response too large", res.statusCode));
            return;
          }

          chunks.push(chunk);
        });
        res.on("end", () => {
          if (settled) {
            return;
          }

          settled = true;
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks),
          });
        });
        res.on("error", fail);
      },
    );
  } catch (e) {
    reject(new WebdavError("WebDAV request could not start"));

    return null;
  }

  req.setTimeout(timeout, () => {
    req.destroy(new WebdavError("WebDAV request timed out"));
  });
  req.on("error", (e) => {
    reject(
      e instanceof WebdavError
        ? e
        : new WebdavError("WebDAV request failed: " + (e.code || e.message)),
    );
  });

  return req;
}

// --- Multistatus parsing -----------------------------------------------------
// Hand-rolled on purpose: the embedded bundle cannot afford a full XML parser,
// and PROPFIND responses only ever need four leaf properties. Namespace
// prefixes vary between servers (D:, d:, or none), so every tag match allows an
// optional prefix and is case-insensitive.

function stripPrefixes(xml) {
  return xml.replace(/<(\/?)[A-Za-z0-9_.-]+:/g, "<$1");
}

function decodeEntities(text) {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, "&");
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch (e) {
    return value;
  }
}

function firstMatch(block, tag) {
  const match = block.match(
    new RegExp("<" + tag + "(?:\\s[^>]*)?>([\\s\\S]*?)</" + tag + ">", "i"),
  );

  return match ? decodeEntities(match[1]).trim() : "";
}

function parseDate(value) {
  if (!value) {
    return 0;
  }

  const ms = Date.parse(value);

  return Number.isFinite(ms) ? ms : 0;
}

// Only properties belonging to a 200 propstat are trusted; a 404 propstat for
// e.g. getcontentlength on a collection must not be read as size 0.
function propBlocks(block) {
  const out = [];
  const re = /<propstat(\s[^>]*)?>([\s\S]*?)<\/propstat>/gi;
  let match;

  while ((match = re.exec(block)) !== null) {
    const inner = match[2];
    const status = firstMatch(inner, "status");
    const ok = status === "" || / 200\b/.test(status);

    if (!ok) {
      continue;
    }

    const prop = inner.match(/<prop(\s[^>]*)?>([\s\S]*?)<\/prop>/i);
    out.push(prop ? prop[2] : inner);
  }

  return out;
}

function parseMultistatus(xml) {
  const normalized = stripPrefixes(xml);
  const results = [];
  const re = /<response(\s[^>]*)?>([\s\S]*?)<\/response>/gi;
  let match;

  while ((match = re.exec(normalized)) !== null) {
    const block = match[2];
    const href = firstMatch(block, "href");

    if (href === "") {
      continue;
    }

    let isDir = false;
    let size = 0;
    let mtime = 0;
    let ctime = 0;

    for (const prop of propBlocks(block)) {
      if (/<collection\s*\/?>/i.test(prop) || /<collection[\s>]/i.test(prop)) {
        isDir = true;
      }

      const length = firstMatch(prop, "getcontentlength");

      if (length !== "" && /^\d+$/.test(length)) {
        size = Number(length);
      }

      mtime = parseDate(firstMatch(prop, "getlastmodified")) || mtime;
      ctime =
        parseDate(firstMatch(prop, "creationdate")) || ctime;
    }

    results.push({ href, isDir, size, mtime, ctime });
  }

  return results;
}

// href -> vault-relative path. Servers are inconsistent about absolute URLs,
// trailing slashes and percent-encoding, so normalise defensively.
function toRelPath(href, basePath) {
  let pathname = href;

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(href)) {
    try {
      pathname = new URL(href).pathname;
    } catch (e) {
      return null;
    }
  }

  pathname = safeDecode(pathname.split("?")[0].split("#")[0]);

  if (!pathname.startsWith("/")) {
    pathname = "/" + pathname;
  }

  const base = basePath.endsWith("/") ? basePath.slice(0, -1) : basePath;

  if (base !== "" && pathname !== base && !pathname.startsWith(base + "/")) {
    return null;
  }

  let rel = pathname.slice(base.length);

  rel = rel.replace(/^\/+/, "").replace(/\/+$/, "");

  // Reject anything that could escape the vault root once joined.
  if (rel.split("/").some((part) => part === ".." || part === ".")) {
    return null;
  }

  return rel;
}

function normalizeBasePath(vaultUrl) {
  const url = new URL(vaultUrl);
  let pathname = safeDecode(url.pathname);

  if (!pathname.endsWith("/")) {
    pathname += "/";
  }

  return pathname;
}

function withSlash(base, rel) {
  if (rel === "") {
    return base;
  }

  return base + rel.split("/").map(encodeURIComponent).join("/") + "/";
}

function fileUrlOf(base, rel) {
  if (rel === "") {
    return base;
  }

  return base + rel.split("/").map(encodeURIComponent).join("/");
}

// --- Tree crawl --------------------------------------------------------------

function fileNode(rel, entry) {
  return {
    type: "file",
    size: entry.size,
    mtime: entry.mtime,
    ctime: entry.ctime || entry.mtime,
  };
}

// Some servers/proxies advertise Infinity but return a partial tree, and some
// refuse it outright. Rather than guess, a single-probe strategy is used:
// request Infinity once, and fall back to bounded depth-1 crawling only when
// the server clearly rejects it.
const INFINITY_REJECT = new Set([400, 405, 501]);

// depth: "auto" prefers one Infinity PROPFIND (a whole vault in a single
// round-trip) and degrades to level-by-level crawling.
async function listTree(vaultUrl, options = {}) {
  const {
    username = "",
    password = "",
    insecure = false,
    concurrency = DEFAULT_CONCURRENCY,
    timeout = DEFAULT_TIMEOUT_MS,
    isIgnored = () => false,
    maxDirectories = 5000,
    maxDepth = 64,
    depth = "auto",
  } = options;

  const url = new URL(vaultUrl);

  // Validate the protocol up front: a misconfigured vault URL is a fatal
  // configuration error, and must not be swallowed by the per-directory
  // tolerance below (which exists only for unreachable subfolders).
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new WebdavError("WebDAV URL must use http or https");
  }

  const basePath = normalizeBasePath(vaultUrl);
  const auth = authHeader(username, password);
  const startedAt = Date.now();
  const stats = { requests: 0, directories: 0, files: 0, truncated: false };
  const origin = url.protocol + "//" + url.host;

  const baseHeaders = {
    Depth: "1",
    "Content-Type": "application/xml; charset=utf-8",
    "User-Agent": "Vitreus-WebDAV/1.4.2",
  };

  if (auth) {
    baseHeaders.Authorization = auth;
  }

  // Safety valve for the bounded crawl. Counting happens in acceptEntry; this
  // only answers "may we descend further?".
  const claim = (rel) => {
    if (stats.directories >= maxDirectories) {
      stats.truncated = true;
      return false;
    }

    return true;
  };

  // Returns the parsed children of one directory (excluding itself).
  const listDirectory = async (rel) => {
    const target = new URL(
      url.protocol + "//" + url.host + withSlash(basePath, rel),
    ).href;
    const res = await request("PROPFIND", target, {
      headers: baseHeaders,
      body: PROPFIND_BODY,
      timeout,
      insecure,
    });

    stats.requests += 1;

    if (res.status === 401) {
      throw new WebdavError("WebDAV 认证失败（401）", 401);
    }

    if (res.status !== 207) {
      throw new WebdavError("WebDAV 目录读取失败（HTTP " + res.status + "）", res.status);
    }

    const entries = parseMultistatus(res.body.toString("utf8"));
    const children = [];

    for (const entry of entries) {
      const childRel = toRelPath(entry.href, basePath);

      if (childRel === null || childRel === "" || childRel === rel) {
        continue; // self entry, or outside the vault
      }

      const parent = childRel.includes("/")
        ? childRel.slice(0, childRel.lastIndexOf("/"))
        : "";

      if (parent !== rel) {
        continue; // server returned extra depth unexpectedly
      }

      children.push({ rel: childRel, entry });
    }

    return children;
  };

  const tree = {};
  const dirMtimes = {};
  // Servers sometimes list the same collection twice (duplicate hrefs, or a
  // directory reachable through two parent entries). Visiting it once keeps the
  // request count and the file counters honest.
  const visited = new Set([""]);

  const acceptEntry = (rel, entry) => {
    if (isIgnored(rel)) {
      return;
    }

    if (entry.isDir) {
      if (tree[rel] === undefined) {
        stats.directories += 1;
      }

      tree[rel] = { type: "directory" };
      dirMtimes[rel] = entry.mtime;
    } else {
      if (tree[rel] === undefined) {
        stats.files += 1;
      }

      tree[rel] = fileNode(rel, entry);
    }
  };

  let usedInfinity = false;

  // Fast path: one Infinity PROPFIND returns the whole vault in a single
  // round-trip. Latency, not throughput, dominates a remote vault crawl
  // (measured: ~10s for 1000 folders at 50ms RTT with depth-1), so this
  // changes the user-visible startup cost by an order of magnitude.
  if (depth === "auto" || depth === "infinity") {
    const target = new URL(origin + basePath).href;

    try {
      const res = await request("PROPFIND", target, {
        headers: Object.assign({}, baseHeaders, { Depth: "infinity" }),
        body: PROPFIND_BODY,
        timeout: Math.max(timeout, 60000),
        insecure,
        maxBytes: 256 * 1024 * 1024,
      });

      stats.requests += 1;

      if (res.status === 207) {
        const entries = parseMultistatus(res.body.toString("utf8"));

        for (const entry of entries) {
          const rel = toRelPath(entry.href, basePath);

          if (rel === null || rel === "") {
            continue;
          }

          // Infinity responses repeat the same href on some servers; count each
          // path once.
          if (visited.has(rel)) {
            continue;
          }

          // Same safety valve as the bounded crawl: a pathological tree must
          // not silently turn into an unbounded in-memory structure.
          if (entry.isDir && stats.directories >= maxDirectories) {
            stats.truncated = true;
            continue;
          }

          visited.add(rel);
          acceptEntry(rel, entry);
        }

        usedInfinity = true;
      } else if (res.status === 401) {
        throw new WebdavError("WebDAV 认证失败（401）", 401);
      } else if (depth === "infinity" || !INFINITY_REJECT.has(res.status)) {
        throw new WebdavError("WebDAV 目录读取失败（HTTP " + res.status + "）", res.status);
      }
    } catch (e) {
      throw e;
    }
  }

  if (!usedInfinity) {
    // Breadth-first, level by level, so concurrency stays bounded without
    // building a per-directory recursion stack.
    let frontier = [""];
    let level = 0;

    while (frontier.length > 0) {
      if (level > maxDepth) {
        stats.truncated = true;
        break;
      }

      const batch = frontier;
      frontier = [];

      for (let i = 0; i < batch.length; i += concurrency) {
        const slice = batch.slice(i, i + concurrency);
        const results = await Promise.all(
          slice.map(async (rel) => ({ rel, children: await listDirectory(rel) })),
        );

        for (const result of results) {
          if (result.rel !== "") {
            tree[result.rel] = { type: "directory" };
          }

          for (const child of result.children) {
            if (child.entry.isDir) {
              acceptEntry(child.rel, child.entry);

              if (!visited.has(child.rel)) {
                visited.add(child.rel);

                if (claim(child.rel)) {
                  frontier.push(child.rel);
                }
              }
            } else {
              acceptEntry(child.rel, child.entry);
            }
          }
        }
      }

      level += 1;
    }
  }

  if (stats.truncated) {
    throw new WebdavError("WebDAV 目录扫描被截断，无法生成完整快照");
  }

  // Root mtime: taken from the root listing when available.
  if (dirMtimes[""] === undefined) {
    dirMtimes[""] = 0;
  }

  return {
    tree,
    dirMtimes,
    stats: Object.assign({}, stats, {
      elapsedMs: Date.now() - startedAt,
      mode: usedInfinity ? "infinity" : "depth1",
    }),
    basePath,
    // Absolute URL for a vault-relative file, usable for GET.
    fileUrlOf: (rel) => origin + fileUrlOf(basePath, rel),
  };
}

// Reads one vault file. Returns { status, body, etag, mtime } so the caller can
// honour conditional requests and surface 304 the same way the local
// persistent-cache path does.
async function readFile(vaultUrl, rel, options = {}) {
  const {
    username = "",
    password = "",
    insecure = false,
    timeout = DEFAULT_TIMEOUT_MS,
    ifNoneMatch = "",
  } = options;

  const url = new URL(vaultUrl);

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new WebdavError("WebDAV URL must use http or https");
  }

  const basePath = normalizeBasePath(vaultUrl);
  const auth = authHeader(username, password);
  const target = url.protocol + "//" + url.host + fileUrlOf(basePath, rel);

  const headers = { "User-Agent": "Vitreus-WebDAV/1.4.2" };

  if (auth) {
    headers.Authorization = auth;
  }

  if (ifNoneMatch) {
    headers["If-None-Match"] = ifNoneMatch;
  }

  const res = await request("GET", target, {
    headers,
    timeout,
    insecure,
    maxBytes: 64 * 1024 * 1024,
  });

  if (res.status === 401) {
    throw new WebdavError("WebDAV 认证失败（401）", 401);
  }

  return {
    status: res.status,
    body: res.body,
    etag: res.headers.etag || "",
    mtime: parseDate(res.headers["last-modified"]),
  };
}

module.exports = {
  WebdavError,
  listTree,
  readFile,
  request,
  agentFor,
  authHeader,
  parseDate,
  fileUrlOf,
  withSlash,
  parseMultistatus,
  toRelPath,
  normalizeBasePath,
  PROPFIND_BODY,
  DEFAULT_CONCURRENCY,
};
