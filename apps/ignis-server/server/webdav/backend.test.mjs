import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createRequire } from "module";
import http from "http";

const require = createRequire(import.meta.url);
const { WebdavBackend } = require("./backend.js");

// In-memory WebDAV server covering the operations the adapter performs.
function makeServer(files) {
  // files: { "rel": { dir: true } | { body: Buffer, mtime: number } }
  const entries = new Map(Object.entries(files));
  const calls = [];

  const childrenOf = (rel) => {
    const prefix = rel === "" ? "" : rel + "/";
    const out = [];

    for (const key of entries.keys()) {
      if (!key.startsWith(prefix) || key === rel) {
        continue;
      }

      const rest = key.slice(prefix.length);

      if (rest === "" || rest.includes("/")) {
        continue;
      }

      out.push(key);
    }

    return out;
  };

  const respondPropfind = (res, rel, depth) => {
    const targets = [rel];

    if (depth === "1") {
      targets.push(...childrenOf(rel));
    } else if (depth === "infinity") {
      for (const key of entries.keys()) {
        if (key !== rel && (rel === "" || key.startsWith(rel + "/"))) {
          targets.push(key);
        }
      }
    }

    const body =
      '<?xml version="1.0"?><D:multistatus xmlns:D="DAV:">' +
      targets
        .map((target) => {
          const spec = entries.get(target);
          const isDir = Boolean(spec && spec.dir);
          const href = "/dav/" + (target === "" ? "" : target.split("/").map(encodeURIComponent).join("/"));
          const props = isDir
            ? "<D:resourcetype><D:collection/></D:resourcetype>" +
              "<D:getlastmodified>" + new Date(spec.mtime || 0).toUTCString() + "</D:getlastmodified>"
            : "<D:resourcetype/>" +
              "<D:getcontentlength>" + spec.body.length + "</D:getcontentlength>" +
              "<D:getlastmodified>" + new Date(spec.mtime || 0).toUTCString() + "</D:getlastmodified>";

          return (
            "<D:response><D:href>" + href + "</D:href>" +
            "<D:propstat><D:prop>" + props + "</D:prop>" +
            "<D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>"
          );
        })
        .join("") +
      "</D:multistatus>";

    res.writeHead(207, { "Content-Type": "application/xml" }).end(body);
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    let rel = decodeURIComponent(url.pathname).slice("/dav".length).replace(/^\/+/, "").replace(/\/+$/, "");

    calls.push({ method: req.method, rel, range: req.headers.range });

    const spec = entries.get(rel);
    const isRoot = rel === "";

    if (req.method === "PROPFIND") {
      if (!spec && !isRoot) {
        res.writeHead(404).end();
        return;
      }

      // Root may be absent from the fixture map but still be a collection.
      if (isRoot && !spec) {
        entries.set("", { dir: true, mtime: 0 });
      }

      respondPropfind(res, rel, req.headers.depth || "0");
      return;
    }

    if (req.method === "GET") {
      if (!spec || spec.dir) {
        res.writeHead(404).end();
        return;
      }

      const body = spec.body;
      const range = req.headers.range;

      if (range) {
        const m = /^bytes=(\d+)-(\d*)$/.exec(range);

        if (m) {
          const start = Number(m[1]);
          const end = m[2] === "" ? body.length - 1 : Number(m[2]);
          const slice = body.subarray(start, end + 1);

          res
            .writeHead(206, {
              "Content-Range": `bytes ${start}-${end}/${body.length}`,
              "Content-Length": slice.length,
            })
            .end(slice);
          return;
        }
      }

      res.writeHead(200, { "Content-Length": body.length }).end(body);
      return;
    }

    res.writeHead(405).end();
  });

  return { server, calls, entries };
}

let handle;
let backend;
let base;

beforeAll(async () => {
  handle = makeServer({
    "笔记/想法.md": { body: Buffer.from("hello 世界", "utf8"), mtime: 1700000000000 },
    "笔记/空.md": { body: Buffer.alloc(0), mtime: 1700000100000 },
    "笔记/深层/子目录/a.md": { body: Buffer.from("a", "utf8"), mtime: 1700000200000 },
    "图 片/pic.png": { body: Buffer.alloc(2048, 7), mtime: 1700000300000 },
    "笔记": { dir: true, mtime: 1700000400000 },
    "笔记/深层": { dir: true, mtime: 1700000500000 },
    "笔记/深层/子目录": { dir: true, mtime: 1700000600000 },
    "图 片": { dir: true, mtime: 1700000700000 },
  });

  await new Promise((resolve) => handle.server.listen(0, "127.0.0.1", resolve));
  base = "http://127.0.0.1:" + handle.server.address().port + "/dav/";
  backend = new WebdavBackend(base, {});
});

afterAll(() => {
  handle.server.close();
});

describe("WebdavBackend path handling", () => {
  it("encodes every path segment, including spaces and CJK", () => {
    expect(backend.urlFor("笔记/想法.md")).toBe(
      base + "%E7%AC%94%E8%AE%B0/%E6%83%B3%E6%B3%95.md",
    );
    expect(backend.urlFor("图 片/pic.png")).toBe(base + "%E5%9B%BE%20%E7%89%87/pic.png");
    expect(backend.urlFor("")).toBe(base);
    expect(backend.urlFor("/a/b/")).toBe(base + "a/b");
  });
});

describe("WebdavBackend reads", () => {
  it("stats a file with size and mtime", async () => {
    const stats = await backend.stat("笔记/想法.md");

    expect(stats.isFile()).toBe(true);
    expect(stats.isDirectory()).toBe(false);
    expect(stats.size).toBe(Buffer.byteLength("hello 世界"));
    expect(stats.mtimeMs).toBe(1700000000000);
  });

  it("stats a directory", async () => {
    const stats = await backend.stat("笔记");

    expect(stats.isDirectory()).toBe(true);
    expect(stats.isFile()).toBe(false);
  });

  it("maps a missing path to ENOENT", async () => {
    await expect(backend.stat("缺失.md")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("lists only direct children", async () => {
    const list = await backend.readdir("笔记");
    const names = list.map((e) => e.name).sort();

    expect(names).toEqual(["想法.md", "深层", "空.md"]);
    expect(list.find((e) => e.name === "深层").isDirectory()).toBe(true);
    expect(list.find((e) => e.name === "想法.md").isFile()).toBe(true);
  });

  it("reads utf8 and binary content", async () => {
    await expect(backend.readFile("笔记/想法.md", "utf8")).resolves.toBe("hello 世界");
    await expect(backend.readFile("图 片/pic.png")).resolves.toHaveLength(2048);
  });

  it("reads a zero-byte file without treating it as missing", async () => {
    const body = await backend.readFile("笔记/空.md");

    expect(body).toHaveLength(0);
  });

  it("access resolves for existing paths and rejects for missing ones", async () => {
    await expect(backend.access("笔记/想法.md")).resolves.toBeUndefined();
    await expect(backend.access("缺失.md")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses to delete a nonempty collection", async () => {
    handle.calls.length = 0;
    await expect(backend.rmdir("笔记")).rejects.toMatchObject({ code: "ENOTEMPTY" });
    expect(handle.calls.some((call) => call.method === "DELETE")).toBe(false);
  });

  it("preserves network errors from access", async () => {
    const offline = new WebdavBackend("http://127.0.0.1:1/dav/");
    await expect(offline.access("anything")).rejects.not.toMatchObject({ code: "ENOENT" });
  });
});

describe("WebdavBackend streaming", () => {
  it("forwards Range and returns 206 with the requested slice", async () => {
    const { status, headers, stream } = await backend.openReadStream("图 片/pic.png", {
      start: 100,
      end: 199,
    });

    expect(status).toBe(206);
    expect(headers["content-range"]).toBe("bytes 100-199/2048");

    const chunks = [];
    await new Promise((resolve, reject) => {
      stream.on("data", (c) => chunks.push(c));
      stream.on("end", resolve);
      stream.on("error", reject);
    });

    expect(Buffer.concat(chunks)).toHaveLength(100);
  });

  it("streams the whole file when no Range is requested", async () => {
    const { status, stream } = await backend.openReadStream("图 片/pic.png");

    expect(status).toBe(200);

    const chunks = [];
    await new Promise((resolve, reject) => {
      stream.on("data", (c) => chunks.push(c));
      stream.on("end", resolve);
      stream.on("error", reject);
    });

    expect(Buffer.concat(chunks)).toHaveLength(2048);
  });
});
