import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// 用最小的假 IndexedDB，避免在 Node 里引入真实实现
function fakeIndexedDB() {
  const rows = new Map();
  const store = {
    get: (key) => {
      const req = { result: rows.get(key), onsuccess: null, onerror: null };
      queueMicrotask(() => req.onsuccess && req.onsuccess());
      return req;
    },
    put: (row) => {
      rows.set(row.path, row);
      const req = { onsuccess: null, onerror: null };
      queueMicrotask(() => req.onsuccess && req.onsuccess());
      return req;
    },
    delete: (key) => {
      rows.delete(key);
      const req = { onsuccess: null, onerror: null };
      queueMicrotask(() => req.onsuccess && req.onsuccess());
      return req;
    },
  };
  return {
    open: () => {
      const req = {
        result: {
          objectStoreNames: { contains: () => true },
          createObjectStore: () => {},
          transaction: () => ({ objectStore: () => store }),
        },
        onsuccess: null,
        onerror: null,
        onupgradeneeded: null,
      };
      queueMicrotask(() => req.onsuccess && req.onsuccess());
      return req;
    },
  };
}

describe("persistent file cache", () => {
  beforeEach(() => {
    vi.stubGlobal("indexedDB", fakeIndexedDB());
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("only treats installed plugin/theme/snippet files as cacheable", async () => {
    const mod = await import("./persistent-cache.js");

    expect(mod.isCacheablePath("/.obsidian/plugins/dataview/main.js")).toBe(true);
    expect(mod.isCacheablePath("/.obsidian/themes/Minimal/theme.css")).toBe(true);
    expect(mod.isCacheablePath("/.obsidian/snippets/a.css")).toBe(true);
    // 笔记正文与配置不进这个缓存
    expect(mod.isCacheablePath("/notes/daily.md")).toBe(false);
    expect(mod.isCacheablePath("/.obsidian/workspace.json")).toBe(false);
    for (const path of ["plugins/x/data.json", "plugins/x/manifest.json", "plugins/x/note.md", "themes/X/manifest.json", "snippets/note.md", "plugins/x/../main.js"]) {
      expect(mod.isCacheablePath("/.obsidian/" + path)).toBe(false);
    }
  });

  it("round-trips an entry and rejects rows without an ETag", async () => {
    const mod = await import("./persistent-cache.js");

    await mod.putCachedEntry("/.obsidian/plugins/x/main.js", '"abc"', "code");
    expect(await mod.getCachedEntry("/.obsidian/plugins/x/main.js")).toEqual({ etag: '"abc"', body: "code" });

    await mod.putCachedEntry("/.obsidian/plugins/x/styles.css", "", "code");
    expect(await mod.getCachedEntry("/.obsidian/plugins/x/styles.css")).toBeNull();
    await mod.putCachedEntry("/.obsidian/plugins/x/data.json", '"data"', "private");
    expect(await mod.getCachedEntry("/.obsidian/plugins/x/data.json")).toBeNull();
  });

  it("prefetch revalidates assets on the second boot without downloading their bodies", async () => {
    const { prefetchVaultContent } = await import("./indexer-prefetch.js");
    const { ContentCache } = await import("./content-cache.js");
    const assets = [".obsidian/plugins/x/main.js", ".obsidian/plugins/x/styles.css", ".obsidian/themes/X/theme.css", ".obsidian/snippets/a.css"];
    const fresh = ["Note.md", ".obsidian/app.json", ".obsidian/plugins/x/data.json", ".obsidian/plugins/x/manifest.json"];
    const tree = Object.fromEntries([...assets, ...fresh].map((path) => [path, { type: "file", size: 10, mtime: 1 }]));
    let revision = "v1";
    let validators = true;
    const downloads = [];
    const requests = [];
    vi.stubGlobal("fetch", vi.fn(async (url, init) => {
      if (url === "/api/fs/batch-read") {
        const paths = JSON.parse(init.body).paths;
        requests.push({ batch: paths });
        downloads.push(...paths);
        return { ok: true, json: async () => ({ files: Object.fromEntries(paths.map((p) => [p, revision + p])) }) };
      }
      const path = new URL(url, "http://test").searchParams.get("path");
      const tag = '"' + revision + '"';
      requests.push({ path, etag: init.headers["If-None-Match"] });
      if (validators && init.headers["If-None-Match"] === tag) return { status: 304 };
      downloads.push(path);
      return { ok: true, status: 200, headers: { get: () => validators ? tag : null }, text: async () => revision + path };
    }));
    async function boot(vault = "v") {
      const cache = new ContentCache();
      await prefetchVaultContent(vault, tree, cache).bulk;
      for (const path of [...assets, ...fresh]) expect(cache.get(path)).toBe(revision + path);
      return cache;
    }

    await boot();
    expect(downloads).toHaveLength(8);
    downloads.length = 0;
    requests.length = 0;
    await boot();
    expect(downloads.sort()).toEqual([...fresh].sort());
    expect(requests.filter((r) => r.path).every((r) => r.etag === '"v1"')).toBe(true);
    expect(requests.flatMap((r) => r.batch || []).sort()).toEqual([...fresh].sort());

    // Deliberately unchanged tree: only a server conditional verdict may validate IDB.
    revision = "v2";
    downloads.length = 0;
    await boot();
    expect(downloads).toHaveLength(8);
    downloads.length = 0;
    await boot();
    expect(downloads.sort()).toEqual([...fresh].sort());

    // A different vault must not inherit validators/bodies from the first vault.
    requests.length = 0;
    await boot("other");
    expect(requests.filter((r) => r.path).every((r) => r.etag === undefined)).toBe(true);

    // Legacy servers omit ETag: always download fresh and discard the old validator.
    validators = false;
    revision = "v3";
    await boot();
    requests.length = 0;
    revision = "v4";
    await boot();
    expect(requests.filter((r) => r.path).every((r) => r.etag === undefined)).toBe(true);
  });

  it("does not overwrite an asset changed while its conditional request was in flight", async () => {
    const { prefetchVaultContent } = await import("./indexer-prefetch.js");
    const { ContentCache } = await import("./content-cache.js");
    const path = ".obsidian/plugins/x/main.js";
    let release;
    vi.stubGlobal("fetch", vi.fn(() => new Promise((resolve) => {
      release = () => resolve({ ok: true, status: 200, headers: { get: () => '"v1"' }, text: async () => "server" });
    })));
    const cache = new ContentCache();
    const result = prefetchVaultContent("v", { [path]: { type: "file", size: 10 } }, cache);
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    cache.set(path, "local");
    release();
    await result.bulk;
    expect(cache.get(path)).toBe("local");
  });

  it("bounds asset validation concurrency and never restores stale content after failures", async () => {
    const { prefetchVaultContent } = await import("./indexer-prefetch.js");
    const { ContentCache } = await import("./content-cache.js");
    const { putCachedEntry } = await import("./persistent-cache.js");
    const paths = Array.from({ length: 20 }, (_, i) => `.obsidian/plugins/p${i}/main.js`);
    await putCachedEntry(paths[0], '"old"', "stale", "v");
    let active = 0;
    let maxActive = 0;
    vi.stubGlobal("fetch", vi.fn(async (url, init) => {
      if (url === "/api/fs/batch-read") {
        return { ok: true, json: async () => ({ files: Object.fromEntries(JSON.parse(init.body).paths.map((p) => [p, "batch-fresh"])) }) };
      }
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active--;
      throw new Error("conditional endpoint unavailable");
    }));
    const cache = new ContentCache();
    const tree = Object.fromEntries(paths.map((p) => [p, { type: "file", size: 10 }]));
    await prefetchVaultContent("v", tree, cache).bulk;
    expect(maxActive).toBe(6);
    for (const path of paths) expect(cache.get(path)).toBe("batch-fresh");
  });
});
