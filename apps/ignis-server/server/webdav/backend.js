// WebDAV backend adapter: exposes a vault on a WebDAV server through the same
// call shapes routes/fs.js already uses against Node's fs. This lets a remote
// vault be mounted without rewriting every route — the routes keep calling
// stat/readFile/readdir/etc., only the provider underneath changes.
//
// Paths are vault-relative ("notes/a.md"); "" means the vault root. Node's fs
// takes absolute paths, so a later wiring step maps resolved paths back to
// relative ones before handing them here.
//
// Fidelity notes, all deliberate:
//  - appendFile is read-modify-write: WebDAV has no append primitive.
//  - utimes uses PROPPATCH on DAV:getlastmodified, which some servers ignore.
//  - mkdir is MKCOL: it cannot create parents, so callers needing recursive
//    behaviour must walk the path.
//  - Nothing here is a stream except openReadStream; large files must use it,
//    never readFile, or a multi-hundred-MB attachment lands in memory.

const { URL } = require("url");
const http = require("http");
const https = require("https");
const {
  WebdavError,
  listTree,
  request,
  agentFor,
  authHeader,
  parseDate,
  parseMultistatus,
  toRelPath,
  normalizeBasePath,
  PROPFIND_BODY,
} = require("./client");

const PROPSTAT_BODY =
  '<?xml version="1.0" encoding="utf-8"?>' +
  '<d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/>' +
  "<d:getcontentlength/><d:getlastmodified/><d:creationdate/></d:prop></d:propfind>";

const STATUS_TO_CODE = {
  401: "EACCES",
  403: "EACCES",
  404: "ENOENT",
  405: "ENOTSUP",
  409: "ENOTEMPTY",
  412: "EPRECONDITION",
  423: "EBUSY",
  507: "ENOSPC",
};

function mapError(status, what) {
  const code = STATUS_TO_CODE[status] || "EIO";
  const err = new Error(`WebDAV ${what} failed (HTTP ${status})`);

  err.code = code;
  err.status = status;

  return err;
}

class WebdavBackend {
  constructor(vaultUrl, options = {}) {
    const url = new URL(vaultUrl);

    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new WebdavError("WebDAV URL must use http or https");
    }

    this.vaultUrl = vaultUrl;
    this.origin = url.protocol + "//" + url.host;
    this.basePath = normalizeBasePath(vaultUrl);
    this.username = options.username || "";
    this.password = options.password || "";
    this.insecure = Boolean(options.insecure);
    this.timeout = options.timeout || 20000;
    this._auth = authHeader(this.username, this.password);
  }

  // Vault-relative path -> absolute URL. Each segment is percent-encoded so
  // Chinese note names and spaces survive the round trip.
  urlFor(rel) {
    const clean = String(rel || "").replace(/^\/+/, "").replace(/\/+$/, "");

    if (clean === "") {
      return this.origin + this.basePath;
    }

    const encoded = clean
      .split("/")
      .map((part) => encodeURIComponent(part))
      .join("/");

    return this.origin + this.basePath + encoded;
  }

  headers(extra = {}) {
    const out = { "User-Agent": "Vitreus-WebDAV/1.4.2" };

    if (this._auth) {
      out.Authorization = this._auth;
    }

    return Object.assign(out, extra);
  }

  async propfind(rel, depth) {
    const res = await request("PROPFIND", this.urlFor(rel), {
      headers: this.headers({
        Depth: String(depth),
        "Content-Type": "application/xml; charset=utf-8",
      }),
      body: rel === "" && depth === 1 ? PROPFIND_BODY : PROPSTAT_BODY,
      timeout: this.timeout,
      insecure: this.insecure,
    });

    if (res.status === 401 || res.status === 403) {
      throw mapError(res.status, "PROPFIND");
    }

    if (res.status === 404) {
      throw mapError(404, "PROPFIND");
    }

    if (res.status !== 207) {
      throw mapError(res.status, "PROPFIND");
    }

    return parseMultistatus(res.body.toString("utf8"));
  }

  async stat(rel) {
    const self = rel.replace(/^\/+|\/+$/g, "");
    const entries = await this.propfind(self, 0);
    const target = entries.find((e) => {
      const found = toRelPath(e.href, this.basePath);

      return found === self;
    }) || entries[0];

    if (!target) {
      throw mapError(404, "stat");
    }

    const mtimeMs = target.mtime || target.ctime || 0;
    const birthMs = target.ctime || mtimeMs;

    const stats = {
      size: target.isDir ? 0 : target.size,
      mtimeMs,
      ctimeMs: birthMs,
      birthtimeMs: birthMs,
      atimeMs: mtimeMs,
      isFile: () => !target.isDir,
      isDirectory: () => target.isDir,
      isSymbolicLink: () => false,
      isBlockDevice: () => false,
      isCharacterDevice: () => false,
      isFIFO: () => false,
      isSocket: () => false,
      isFileSync() {
        return this.isFile();
      },
      isDirectorySync() {
        return this.isDirectory();
      },
      mtime: new Date(mtimeMs),
      ctime: new Date(birthMs),
      birthtime: new Date(birthMs),
      atime: new Date(mtimeMs),
    };

    return stats;
  }

  // Mirrors fs.readdir(..., { withFileTypes: true }) closely enough for the
  // routes, which only call name/isDirectory/isFile on each entry.
  async readdir(rel) {
    const self = rel.replace(/^\/+|\/+$/g, "");
    const entries = await this.propfind(self, 1);
    const out = [];

    for (const entry of entries) {
      const child = toRelPath(entry.href, this.basePath);

      if (child === null || child === self) {
        continue;
      }

      const parent = child.includes("/")
        ? child.slice(0, child.lastIndexOf("/"))
        : "";

      if (parent !== self) {
        continue;
      }

      const name = child.slice(child.lastIndexOf("/") + 1);
      const isDir = entry.isDir;

      out.push({
        name,
        isDirectory: () => isDir,
        isFile: () => !isDir,
        isSymbolicLink: () => false,
      });
    }

    return out;
  }

  async readFile(rel, encoding) {
    const res = await request("GET", this.urlFor(rel), {
      headers: this.headers(),
      timeout: this.timeout,
      insecure: this.insecure,
      maxBytes: 256 * 1024 * 1024,
    });

    if (res.status === 404) {
      throw mapError(404, "readFile");
    }

    if (res.status === 401 || res.status === 403) {
      throw mapError(res.status, "readFile");
    }

    if (res.status !== 200 && res.status !== 206) {
      throw mapError(res.status, "readFile");
    }

    if (encoding === "utf8" || encoding === "utf-8") {
      return res.body.toString("utf8");
    }

    return res.body;
  }

  async access(rel) {
    await this.stat(rel);
  }

  // Returns { status, headers, stream } so callers can pipe straight to the
  // response. This is the only path attachments should travel: it forwards
  // Range, so a 500 MB PDF costs one ranged read instead of a full download.
  openReadStream(rel, options = {}) {
    const target = this.urlFor(rel);
    const url = new URL(target);
    const transport = url.protocol === "https:" ? https : http;
    const headers = this.headers();

    if (options.range) {
      headers.Range = options.range;
    } else if (options.start !== undefined) {
      const end = options.end !== undefined ? options.end : "";
      headers.Range = `bytes=${options.start}-${end}`;
    }

    if (options.ifRange) {
      headers["If-Range"] = options.ifRange;
    }

    if (options.ifNoneMatch) {
      headers["If-None-Match"] = options.ifNoneMatch;
    }

    return new Promise((resolve, reject) => {
      const req = transport.request(
        {
          method: "GET",
          hostname: url.hostname.replace(/^\[|\]$/g, ""),
          port: url.port || undefined,
          path: url.pathname + url.search,
          headers,
          agent: agentFor(url.protocol, this.insecure),
          rejectUnauthorized: !this.insecure,
        },
        (res) => resolve({ status: res.statusCode, headers: res.headers, stream: res }),
      );

      req.setTimeout(this.timeout * 3, () => {
        req.destroy(new WebdavError("WebDAV stream timed out"));
      });
      req.on("error", reject);
      req.end();
    });
  }

  // Whole-vault tree in a single PROPFIND. The per-directory walk that crawl.js
  // performs for a local vault costs one request per file and per directory
  // (1065 round-trips, 3.5s on a 1064-file vault); Depth: infinity returns the
  // same data in one round-trip.
  async listTree(options = {}) {
    return listTree(this.origin + this.basePath, {
      username: this.username,
      password: this.password,
      insecure: this.insecure,
      timeout: Math.max(this.timeout, 60000),
      isIgnored: options.isIgnored,
      maxDirectories: options.maxDirectories,
    });
  }

  // --- writes ---------------------------------------------------------------
  // Implemented for parity with Node's fs, but NOT yet exercised against a real
  // server. Treat as unverified until the write probe passes.

  async writeFile(rel, data, encoding) {
    const body = Buffer.isBuffer(data)
      ? data
      : Buffer.from(String(data), encoding === "binary" ? "binary" : "utf8");

    const res = await request("PUT", this.urlFor(rel), {
      headers: this.headers({ "Content-Type": "application/octet-stream" }),
      body,
      timeout: this.timeout,
      insecure: this.insecure,
    });

    if (res.status < 200 || res.status >= 300) {
      throw mapError(res.status, "writeFile");
    }
  }

  // WebDAV has no append. Read-modify-write is the only option and it is not
  // atomic; callers that care about durability must serialise through the
  // existing coalescer.
  async appendFile(rel, data, encoding) {
    let existing = Buffer.alloc(0);

    try {
      existing = await this.readFile(rel);
    } catch (e) {
      if (e.code !== "ENOENT") {
        throw e;
      }
    }

    const addition = Buffer.isBuffer(data)
      ? data
      : Buffer.from(String(data), encoding === "binary" ? "binary" : "utf8");

    await this.writeFile(rel, Buffer.concat([existing, addition]));
  }

  async mkdir(rel) {
    const res = await request("MKCOL", this.urlFor(rel), {
      headers: this.headers(),
      timeout: this.timeout,
      insecure: this.insecure,
    });

    if (res.status === 405) {
      // Already exists: Node's mkdir would throw EEXIST.
      const err = new Error("EEXIST: directory exists");

      err.code = "EEXIST";
      throw err;
    }

    if (res.status === 409) {
      const err = new Error("ENOENT: parent directory missing");

      err.code = "ENOENT";
      throw err;
    }

    if (res.status < 200 || res.status >= 300) {
      throw mapError(res.status, "mkdir");
    }
  }

  async rename(fromRel, toRel_) {
    const res = await request("MOVE", this.urlFor(fromRel), {
      headers: this.headers({
        Destination: this.urlFor(toRel_),
        Overwrite: "T",
      }),
      timeout: this.timeout,
      insecure: this.insecure,
    });

    if (res.status === 412) {
      const err = new Error("EEXIST: destination exists");

      err.code = "EEXIST";
      throw err;
    }

    if (res.status < 200 || res.status >= 300) {
      throw mapError(res.status, "rename");
    }
  }

  async copyFile(fromRel, toRel_) {
    const res = await request("COPY", this.urlFor(fromRel), {
      headers: this.headers({
        Destination: this.urlFor(toRel_),
        Overwrite: "T",
        Depth: "0",
      }),
      timeout: this.timeout,
      insecure: this.insecure,
    });

    if (res.status >= 200 && res.status < 300) {
      return;
    }

    // OpenList/AList answers COPY with 500 regardless of Destination form, so a
    // server-side copy cannot be relied on. Fall back to read + write, which
    // costs a full transfer through this process but is correct everywhere.
    if (res.status === 500 || res.status === 405 || res.status === 501) {
      const body = await this.readFile(fromRel);

      await this.writeFile(toRel_, body);
      return;
    }

    throw mapError(res.status, "copyFile");
  }

  async unlink(rel) {
    const res = await request("DELETE", this.urlFor(rel), {
      headers: this.headers(),
      timeout: this.timeout,
      insecure: this.insecure,
    });

    if (res.status === 404) {
      throw mapError(404, "unlink");
    }

    // A 207 DELETE can contain individual failures; do not report a partial
    // deletion as success when the multistatus has not been validated.
    if (res.status === 207 || res.status < 200 || res.status >= 300) {
      throw mapError(res.status, "unlink");
    }
  }

  async rmdir(rel) {
    const children = await this.readdir(rel);
    if (children.length > 0) {
      const err = new Error("ENOTEMPTY: directory not empty");
      err.code = "ENOTEMPTY";
      throw err;
    }
    // WebDAV DELETE may recursively remove a collection. Checking first does
    // not prevent another client creating a child before DELETE arrives.
    await this.unlink(rel);
  }

  async rm(rel, options = {}) {
    if (options.recursive) {
      await this.unlink(rel);
      return;
    }

    const stats = await this.stat(rel).catch(() => null);

    if (stats && stats.isDirectory()) {
      const children = await this.readdir(rel);

      if (children.length > 0) {
        const err = new Error("ENOTEMPTY: directory not empty");

        err.code = "ENOTEMPTY";
        throw err;
      }
    }

    await this.unlink(rel);
  }

  async utimes(rel, atime, mtime) {
    const stamp = new Date(mtime instanceof Date ? mtime : mtime * 1000).toUTCString();
    const body =
      '<?xml version="1.0" encoding="utf-8"?>' +
      '<d:propertyupdate xmlns:d="DAV:"><d:set><d:prop>' +
      "<d:getlastmodified>" + stamp + "</d:getlastmodified>" +
      "</d:prop></d:set></d:propertyupdate>";

    const res = await request("PROPPATCH", this.urlFor(rel), {
      headers: this.headers({ "Content-Type": "application/xml; charset=utf-8" }),
      body,
      timeout: this.timeout,
      insecure: this.insecure,
    });

    // Many servers silently ignore or reject mtime updates; that must not fail
    // a write that otherwise succeeded, so only transport errors propagate.
    return res.status;
  }
}

module.exports = { WebdavBackend, mapError };
