import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createRequire } from "module";
import http from "http";

const require = createRequire(import.meta.url);
const { listTree, readFile, parseMultistatus, toRelPath, WebdavError } = require("./client.js");

// A tiny in-memory WebDAV server. Only PROPFIND depth-1 is implemented, which is
// all the tree crawl needs; the point is to exercise the real HTTP path rather
// than stub the transport.
function makeServer(files) {
  // files: { "rel/path": { isDir: true } | { size, mtime, ctime } }
  const children = new Map();

  const ensure = (rel) => {
    if (!children.has(rel)) {
      children.set(rel, []);
    }

    return children.get(rel);
  };

  ensure("");

  for (const [rel, spec] of Object.entries(files)) {
    const parts = rel.split("/");
    let parent = "";

    for (let i = 0; i < parts.length - 1; i += 1) {
      const dir = (parent === "" ? "" : parent + "/") + parts[i];

      if (!ensure(parent).some((e) => e.rel === dir)) {
        ensure(parent).push({ rel: dir, spec: { isDir: true } });
      }
      ensure(dir);
      parent = dir;
    }

    ensure(parent).push({ rel, spec });
  }

  const requests = [];

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    // Strip the /dav prefix used by the tests.
    let rel = decodeURIComponent(url.pathname);

    if (!rel.startsWith("/dav")) {
      res.writeHead(404).end();
      return;
    }

    rel = rel.slice("/dav".length).replace(/^\/+/, "").replace(/\/+$/, "");

    requests.push({ method: req.method, rel, depth: req.headers.depth, auth: req.headers.authorization });

    if (req.headers.authorization !== "Basic " + Buffer.from("u:p").toString("base64")) {
      res.writeHead(401).end("unauthorized");
      return;
    }

    if (req.method === "GET") {
      if (req.headers["if-none-match"] === '"v1"') {
        res.writeHead(304).end();
        return;
      }

      res.writeHead(200, { ETag: '"v1"' }).end("body-of-" + rel);
      return;
    }

    if (req.method !== "PROPFIND") {
      res.writeHead(405).end();
      return;
    }

    if (!children.has(rel)) {
      res.writeHead(404).end();
      return;
    }

    let entries = [{ rel, spec: { isDir: true } }].concat(children.get(rel));

    if ((req.headers.depth || "").toLowerCase() === "infinity") {
      entries = [{ rel, spec: { isDir: true } }];
      const stack = [rel];

      while (stack.length > 0) {
        const cur = stack.pop();

        for (const child of children.get(cur) || []) {
          entries.push(child);
          if (child.spec.isDir) {
            stack.push(child.rel);
          }
        }
      }
    }
    const body =
      '<?xml version="1.0" encoding="utf-8"?><d:multistatus xmlns:d="DAV:">' +
      entries
        .map((entry) => {
          const href = "/dav/" + (entry.rel === "" ? "" : entry.rel.split("/").map(encodeURIComponent).join("/"));
          const isDir = Boolean(entry.spec.isDir);
          const props = isDir
            ? "<d:resourcetype><d:collection/></d:resourcetype>"
            : "<d:resourcetype/>" +
              "<d:getcontentlength>" + entry.spec.size + "</d:getcontentlength>" +
              "<d:getlastmodified>" + new Date(entry.spec.mtime).toUTCString() + "</d:getlastmodified>" +
              (entry.spec.ctime
                ? "<d:creationdate>" + new Date(entry.spec.ctime).toISOString() + "</d:creationdate>"
                : "");

          return (
            "<d:response><d:href>" + href + "</d:href>" +
            '<d:propstat><d:prop>' + props + "</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>" +
            "</d:response>"
          );
        })
        .join("") +
      "</d:multistatus>";

    res.writeHead(207, { "Content-Type": "application/xml" }).end(body);
  });

  return { server, requests };
}

let handle;
let base;

beforeAll(async () => {
  handle = makeServer({
    "笔记/想法.md": { size: 120, mtime: 1700000000000, ctime: 1690000000000 },
    "笔记/子目录/deep.md": { size: 20, mtime: 1700000500000 },
    "a b & c.md": { size: 7, mtime: 1700001000000 },
    ".obsidian/app.json": { size: 30, mtime: 1700002000000 },
    "图片/图 一.png": { size: 999, mtime: 1700003000000 },
  });

  await new Promise((resolve) => handle.server.listen(0, "127.0.0.1", resolve));
  base = "http://127.0.0.1:" + handle.server.address().port + "/dav/";
});

afterAll(() => {
  handle.server.close();
});

const creds = { username: "u", password: "p" };

describe("webdav tree crawl", () => {
  it("maps the remote tree into the crawler's flat structure", async () => {
    const result = await listTree(base, creds);

    expect(result.tree["笔记"]).toEqual({ type: "directory" });
    expect(result.tree["笔记/想法.md"]).toEqual({
      type: "file",
      size: 120,
      mtime: 1700000000000,
      ctime: 1690000000000,
    });
    expect(result.tree["笔记/子目录"]).toEqual({ type: "directory" });
    expect(result.tree["笔记/子目录/deep.md"].size).toBe(20);
    expect(result.tree[""]).toBeUndefined();

    expect(result.stats.files).toBe(5);
    expect(result.stats.directories).toBe(4); // 笔记, 笔记/子目录, .obsidian, 图片
  });

  it("decodes percent-encoded and spaced paths", async () => {
    const result = await listTree(base, creds);

    expect(result.tree["a b & c.md"]).toBeTruthy();
    expect(result.tree["图片/图 一.png"].size).toBe(999);
  });

  it("does not treat a UTF-16 length or missing ctime as fatal", async () => {
    const result = await listTree(base, creds);

    expect(result.tree["笔记/子目录/deep.md"].mtime).toBe(1700000500000);
    // ctime falls back to mtime when the server omits creationdate.
    expect(result.tree["笔记/子目录/deep.md"].ctime).toBe(1700000500000);
  });

  it("honours the ignore predicate so dotfolders can be skipped", async () => {
    const result = await listTree(
      base,
      Object.assign({ isIgnored: (rel) => rel.split("/").some((p) => p.startsWith(".")) }, creds),
    );

    expect(result.tree[".obsidian/app.json"]).toBeUndefined();
  });

  it("uses depth 1 requests and keeps concurrency bounded", async () => {
    handle.requests.length = 0;
    await listTree(base, Object.assign({ depth: "depth1", concurrency: 2 }, creds));

    expect(handle.requests.every((r) => r.depth === "1")).toBe(true);
    expect(handle.requests.length).toBeGreaterThanOrEqual(4);
  });

  it("fails closed on bad credentials", async () => {
    await expect(listTree(base, { username: "u", password: "wrong" })).rejects.toBeInstanceOf(
      WebdavError,
    );
  });

  it("rejects non-http protocols before any request", async () => {
    await expect(listTree("file:///etc/passwd", creds)).rejects.toBeInstanceOf(WebdavError);
  });

  it("propagates offline, forbidden and child directory failures", async () => {
    const failing = http.createServer((req, res) => {
      if (req.url === "/offline/") return req.socket.destroy();
      if (req.url === "/forbidden/") return res.writeHead(403).end();
      if (req.url === "/dav/child/") return res.writeHead(500).end();
      return res.writeHead(207).end('<multistatus><response><href>/dav/child/</href><propstat><prop><resourcetype><collection/></resourcetype></prop><status>HTTP/1.1 200 OK</status></propstat></response></multistatus>');
    });
    await new Promise((resolve) => failing.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${failing.address().port}`;
    try {
      await expect(listTree(origin + "/offline/", creds)).rejects.toThrow();
      await expect(listTree(origin + "/forbidden/", creds)).rejects.toMatchObject({ status: 403 });
      await expect(listTree(origin + "/dav/", { ...creds, depth: "depth1" })).rejects.toMatchObject({ status: 500 });
      await expect(listTree(base, { ...creds, depth: "depth1", maxDepth: 0 })).rejects.toThrow(/截断/);
    } finally {
      failing.close();
    }
  });

  it("stops at the directory cap instead of crawling forever", async () => {
    await expect(listTree(base, Object.assign({ maxDirectories: 1 }, creds))).rejects.toThrow(/截断/);
  });

  it("reports remote read URLs relative to the vault", async () => {
    const result = await listTree(base, creds);

    expect(result.fileUrlOf("笔记/想法.md")).toBe(base + "%E7%AC%94%E8%AE%B0/%E6%83%B3%E6%B3%95.md");
  });
});

describe("multistatus parsing", () => {
  it("reads properties without a namespace prefix", () => {
    const xml =
      "<multistatus><response><href>/dav/f.md</href><propstat><prop>" +
      "<resourcetype/><getcontentlength>12</getcontentlength>" +
      "<getlastmodified>Tue, 14 Nov 2023 22:13:20 GMT</getlastmodified>" +
      "</prop><status>HTTP/1.1 200 OK</status></propstat></response></multistatus>";
    const [entry] = parseMultistatus(xml);

    expect(entry.size).toBe(12);
    expect(entry.isDir).toBe(false);
    expect(entry.mtime).toBe(Date.parse("Tue, 14 Nov 2023 22:13:20 GMT"));
  });

  it("ignores 404 propstats so collection sizes are not fabricated", () => {
    const xml =
      "<D:multistatus><D:response><D:href>/dav/dir/</D:href>" +
      "<D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop>" +
      "<D:status>HTTP/1.1 200 OK</D:status></D:propstat>" +
      "<D:propstat><D:prop><D:getcontentlength/></D:prop>" +
      "<D:status>HTTP/1.1 404 Not Found</D:status></D:propstat>" +
      "</D:response></D:multistatus>";
    const [entry] = parseMultistatus(xml);

    expect(entry.isDir).toBe(true);
    expect(entry.size).toBe(0);
  });

  it("refuses hrefs that would escape the vault root", () => {
    expect(toRelPath("/dav/../../etc/passwd", "/dav/")).toBeNull();
    expect(toRelPath("/other/x.md", "/dav/")).toBeNull();
    expect(toRelPath("http://host/dav/x.md", "/dav/")).toBe("x.md");
    expect(toRelPath("/dav/a/b/", "/dav/")).toBe("a/b");
  });
});

describe("crawl strategy", () => {
  it("prefers a single Infinity PROPFIND for the whole vault", async () => {
    handle.requests.length = 0;
    const result = await listTree(base, creds);

    expect(result.stats.mode).toBe("infinity");
    expect(result.stats.requests).toBe(1);
    expect(result.stats.files).toBe(5);
    expect(handle.requests).toHaveLength(1);
  });

  it("falls back to bounded crawling when the server rejects Infinity", async () => {
    const strict = http.createServer((req, res) => {
      if ((req.headers.depth || "").toLowerCase() === "infinity") {
        res.writeHead(405).end();
        return;
      }

      res
        .writeHead(207, { "Content-Type": "application/xml" })
        .end(
          '<d:multistatus xmlns:d="DAV:">' +
            "<d:response><d:href>/dav/</d:href><d:propstat><d:prop>" +
            "<d:resourcetype><d:collection/></d:resourcetype>" +
            "</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>" +
            "<d:response><d:href>/dav/one.md</d:href><d:propstat><d:prop>" +
            "<d:resourcetype/><d:getcontentlength>3</d:getcontentlength>" +
            "</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>" +
            "</d:multistatus>",
        );
    });

    await new Promise((resolve) => strict.listen(0, "127.0.0.1", resolve));

    try {
      const result = await listTree(
        "http://127.0.0.1:" + strict.address().port + "/dav/",
        creds,
      );

      expect(result.stats.mode).toBe("depth1");
      expect(result.tree["one.md"].size).toBe(3);
    } finally {
      strict.close();
    }
  });

  it("counts each directory once even when the server repeats hrefs", async () => {
    for (const depth of ["auto", "depth1"]) {
      const result = await listTree(base, Object.assign({ depth }, creds));

      expect(result.stats.directories).toBe(4);
    }
  });

  it("applies the directory cap in both strategies", async () => {
    for (const depth of ["auto", "depth1"]) {
      await expect(listTree(base, Object.assign({ depth, maxDirectories: 1 }, creds))).rejects.toThrow(/截断/);
    }
  });
});

describe("readFile", () => {
  it("returns body, etag and honours conditional requests", async () => {
    const plain = await readFile(base, "笔记/想法.md", creds);

    expect(plain.status).toBe(200);
    expect(plain.body.length).toBeGreaterThan(0);

    const conditional = await readFile(base, "笔记/想法.md", Object.assign({ ifNoneMatch: '"v1"' }, creds));

    expect(conditional.status).toBe(304);
  });

  it("rejects non-http protocols before any request", async () => {
    await expect(readFile("file:///etc/passwd", "x.md", creds)).rejects.toBeInstanceOf(WebdavError);
  });
});
