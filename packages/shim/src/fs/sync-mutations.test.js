import { describe, it, expect, vi, afterEach } from "vitest";
import { createFsSync } from "./sync.js";
import { resolvePath, registerPathResolver, _reset } from "./transforms.js";
import { isRecentSentOp } from "./echo-guard.js";
import { MetadataCache } from "./metadata-cache.js";
import { ContentCache } from "./content-cache.js";
import * as durability from "./write-durability.js";
import * as coalescer from "./write-coalescer.js";

function makeDeps() {
  const store = new Map();

  const metadataCache = {
    has: (p) => store.has(p),
    get: (p) => (store.has(p) ? store.get(p) : null),
    set: (p, m) => store.set(p, m),
    delete: (p) => store.delete(p),
    rename: (a, b) => {
      if (store.has(a)) {
        store.set(b, store.get(a));
        store.delete(a);
      }

      return [];
    },
    toStat: (p) =>
      store.has(p)
        ? {
            type: store.get(p).type,
            isDirectory: () => store.get(p).type === "directory",
            isFile: () => store.get(p).type === "file",
          }
        : null,
    readdir: () => [],
  };

  const contentCache = {
    get: () => null,
    set: vi.fn(),
    delete: vi.fn(),
    invalidate: vi.fn(),
  };

  const transport = {
    mkdir: vi.fn(async () => {}),
    rmdir: vi.fn(async () => {}),
    rm: vi.fn(async () => {}),
    rename: vi.fn(async () => {}),
    copyFile: vi.fn(async () => {}),
    appendFile: vi.fn(async () => {}),
    utimes: vi.fn(async () => {}),
    stat: vi.fn(async () => ({ type: "file", size: 1 })),
    readFileSync: vi.fn(() => {
      throw new Error("transport.readFileSync should not be called");
    }),
  };

  return { metadataCache, contentCache, transport, store };
}

describe("sync fs mutations", () => {
  it("lstatSync mirrors statSync", () => {
    const deps = makeDeps();
    const fs = createFsSync(
      deps.metadataCache,
      deps.contentCache,
      deps.transport,
    );
    deps.store.set(resolvePath("dir"), { type: "directory" });

    expect(fs.lstatSync("dir").isDirectory()).toBe(true);
  });

  it("mkdirSync updates the cache and fires the transport", () => {
    const deps = makeDeps();
    const fs = createFsSync(
      deps.metadataCache,
      deps.contentCache,
      deps.transport,
    );

    fs.mkdirSync("newdir", { recursive: true });

    expect(deps.store.get("newdir")).toEqual({ type: "directory" });
    expect(deps.transport.mkdir).toHaveBeenCalledWith("newdir", true);
  });

  it("rmSync deletes from the cache and fires the transport", () => {
    const deps = makeDeps();
    const fs = createFsSync(
      deps.metadataCache,
      deps.contentCache,
      deps.transport,
    );
    const key = resolvePath("gone.md");
    deps.store.set(key, { type: "file" });

    fs.rmSync("gone.md", { recursive: true });

    expect(deps.store.has(key)).toBe(false);
    expect(deps.transport.rm).toHaveBeenCalled();
  });

  it("renameSync moves cache metadata and fires the transport", () => {
    const deps = makeDeps();
    const fs = createFsSync(
      deps.metadataCache,
      deps.contentCache,
      deps.transport,
    );
    const from = resolvePath("a.md");
    const to = resolvePath("b.md");
    deps.store.set(from, { type: "file", size: 2 });

    fs.renameSync("a.md", "b.md");

    expect(deps.store.has(from)).toBe(false);
    expect(deps.store.get(to)).toEqual({ type: "file", size: 2 });
    expect(deps.transport.rename).toHaveBeenCalled();
  });

  it("renameSync drops the content the destination held", () => {
    const metadataCache = new MetadataCache();
    const contentCache = new ContentCache();
    const transport = { rename: vi.fn(async () => {}) };
    const fs = createFsSync(metadataCache, contentCache, transport);
    const from = resolvePath("src.md");
    const to = resolvePath("dst.md");

    metadataCache.set(from, { type: "file", size: 3 });
    metadataCache.set(to, { type: "file", size: 5 });
    contentCache.set(to, "stale");

    fs.renameSync("src.md", "dst.md");

    expect(contentCache.get(to)).toBeNull();
    expect(metadataCache.get(to)).toEqual({ type: "file", size: 3 });
  });

  it("copyFileSync optimistically mirrors source metadata and fires the transport", () => {
    const deps = makeDeps();
    const fs = createFsSync(
      deps.metadataCache,
      deps.contentCache,
      deps.transport,
    );
    const srcKey = resolvePath("src.md");
    const destKey = resolvePath("dest.md");
    deps.store.set(srcKey, { type: "file", size: 9 });

    fs.copyFileSync("src.md", "dest.md");

    expect(deps.store.get(destKey)).toEqual({ type: "file", size: 9 });
    expect(deps.transport.copyFile).toHaveBeenCalled();
  });

  it("utimesSync sets mtime and fires the transport", async () => {
    const deps = makeDeps();
    const fs = createFsSync(
      deps.metadataCache,
      deps.contentCache,
      deps.transport,
    );
    const key = resolvePath("note.md");
    deps.store.set(key, { type: "file", mtime: 0 });

    fs.utimesSync("note.md", 111, 222);
    await new Promise((r) => setTimeout(r, 0));

    expect(deps.store.get(key).mtime).toBe(222000);
    expect(deps.transport.utimes).toHaveBeenCalledWith(key, 111000, 222000);
  });

  it("utimesSync converts a Date argument to milliseconds", async () => {
    const deps = makeDeps();
    const fs = createFsSync(
      deps.metadataCache,
      deps.contentCache,
      deps.transport,
    );
    const key = resolvePath("dated.md");
    deps.store.set(key, { type: "file", mtime: 0 });

    const when = new Date(1783339200000);
    fs.utimesSync("dated.md", when, when);
    await new Promise((r) => setTimeout(r, 0));

    expect(deps.store.get(key).mtime).toBe(1783339200000);
    expect(deps.transport.utimes).toHaveBeenCalledWith(
      key,
      1783339200000,
      1783339200000,
    );
  });
});

describe("sync write and unlink ordering", () => {
  afterEach(() => {
    coalescer._reset();
    durability._reset();
    vi.useRealTimers();
  });

  it("flushes a buffered write, deletes it, then preserves a later sync write", async () => {
    const metadata = new MetadataCache();
    const content = new ContentCache();
    const disk = new Map();
    const calls = [];
    let release;
    const transport = {
      writeFile: vi.fn(async (path, data) => {
        calls.push(data);
        if (data === "before") await new Promise((resolve) => { release = resolve; });
        disk.set(path, data);
        return { mtime: 1, size: data.length };
      }),
      unlink: vi.fn(async (path) => { calls.push("unlink"); disk.delete(path); }),
    };
    coalescer.initWriteCoalescer(transport);
    durability.initWriteDurability(transport, coalescer.enqueue);
    const fs = createFsSync(metadata, content, transport);
    coalescer.bufferWrite("note.md", "before", "utf8");
    expect(fs.unlinkSync("note.md")).toBeUndefined();
    expect(fs.writeFileSync("note.md", "after")).toBeUndefined();
    await vi.waitFor(() => expect(calls).toEqual(["before"]));
    release();
    await vi.waitFor(() => expect(calls).toEqual(["before", "unlink", "after"]));
    expect(disk.get("note.md")).toBe("after");
    expect(content.get("note.md")).toBe("after");
    expect(metadata.get("note.md").size).toBe(5);
  });

  it("does not restore deleted metadata when an earlier write completes", async () => {
    const metadata = new MetadataCache();
    const content = new ContentCache();
    let release;
    const transport = {
      writeFile: vi.fn(() => new Promise((resolve) => { release = resolve; })),
      unlink: vi.fn(async () => {}),
    };
    coalescer.initWriteCoalescer(transport);
    durability.initWriteDurability(transport, coalescer.enqueue);
    const fs = createFsSync(metadata, content, transport);
    fs.writeFileSync("note.md", "old");
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    fs.unlinkSync("note.md");
    release({ mtime: 10, size: 3 });
    await vi.waitFor(() => expect(transport.unlink).toHaveBeenCalledOnce());
    expect(metadata.get("note.md")).toBeNull();
    expect(content.get("note.md")).toBeNull();
  });

  it("does not overwrite newer optimistic metadata with an older write result", async () => {
    const metadata = new MetadataCache();
    const content = new ContentCache();
    let release;
    const transport = {
      writeFile: vi.fn().mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }))
        .mockImplementationOnce(() => new Promise(() => {})),
    };
    coalescer.initWriteCoalescer(transport);
    durability.initWriteDurability(transport, coalescer.enqueue);
    const fs = createFsSync(metadata, content, transport);
    fs.writeFileSync("note.md", "old");
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    fs.writeFileSync("note.md", "newer data");
    const current = metadata.get("note.md");
    release({ mtime: 1, size: 3 });
    await vi.waitFor(() => expect(transport.writeFile).toHaveBeenCalledTimes(2));
    expect(metadata.get("note.md")).toEqual(current);
    expect(content.get("note.md")).toBe("newer data");
  });

  it("suppresses ENOENT and logs other background delete errors", async () => {
    const metadata = new MetadataCache();
    const content = new ContentCache();
    const missing = Object.assign(new Error("missing"), { code: "ENOENT" });
    const denied = Object.assign(new Error("denied"), { code: "EACCES" });
    const transport = { unlink: vi.fn().mockRejectedValueOnce(missing).mockRejectedValueOnce(denied) };
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const fs = createFsSync(metadata, content, transport);
      expect(fs.unlinkSync("missing.md")).toBeUndefined();
      expect(fs.unlinkSync("denied.md")).toBeUndefined();
      await vi.waitFor(() => expect(log).toHaveBeenCalledOnce());
      expect(log).toHaveBeenCalledWith("[shim:fs] unlinkSync background delete failed:", "denied.md", denied);
    } finally {
      log.mockRestore();
    }
  });

  it("cancels retries of a failed write after unlink", async () => {
    vi.useFakeTimers();
    const metadata = new MetadataCache();
    const content = new ContentCache();
    const disk = new Map([["note.md", "original"]]);
    const transport = {
      writeFile: vi.fn().mockRejectedValueOnce(new Error("offline")).mockImplementation(async (path, data) => {
        disk.set(path, data);
        return { mtime: 1, size: data.length };
      }),
      unlink: vi.fn(async (path) => { disk.delete(path); }),
    };
    coalescer.initWriteCoalescer(transport);
    durability.initWriteDurability(transport, coalescer.enqueue);
    const fs = createFsSync(metadata, content, transport);
    fs.writeFileSync("note.md", "failed");
    await vi.advanceTimersByTimeAsync(0);
    fs.unlinkSync("note.md");
    await vi.advanceTimersByTimeAsync(0);
    durability.retryAll();
    await vi.advanceTimersByTimeAsync(120000);
    expect(transport.writeFile).toHaveBeenCalledTimes(1);
    expect(disk.has("note.md")).toBe(false);
    expect(metadata.get("note.md")).toBeNull();
  });
});

describe("directory mutations honor path resolvers", () => {
  afterEach(() => _reset());

  it("mkdirSync uses the resolved path for cache, echo-guard, and transport", () => {
    registerPathResolver(
      (p) => p === "logical/dir",
      () => "physical/dir",
    );

    const deps = makeDeps();
    const fs = createFsSync(
      deps.metadataCache,
      deps.contentCache,
      deps.transport,
    );

    fs.mkdirSync("logical/dir", { recursive: true });

    expect(deps.store.get("physical/dir")).toEqual({ type: "directory" });
    expect(deps.store.has("logical/dir")).toBe(false);
    expect(deps.transport.mkdir).toHaveBeenCalledWith("physical/dir", true);
    expect(isRecentSentOp("physical/dir")).toBe(true);
    expect(isRecentSentOp("logical/dir")).toBe(false);
  });

  it("rmdirSync uses the resolved path for cache, echo-guard, and transport", () => {
    registerPathResolver(
      (p) => p === "logical/dir",
      () => "physical/dir",
    );

    const deps = makeDeps();
    const fs = createFsSync(
      deps.metadataCache,
      deps.contentCache,
      deps.transport,
    );
    deps.store.set("physical/dir", { type: "directory" });

    fs.rmdirSync("logical/dir");

    expect(deps.store.has("physical/dir")).toBe(false);
    expect(deps.transport.rmdir).toHaveBeenCalledWith("physical/dir");
    expect(isRecentSentOp("physical/dir")).toBe(true);
  });
});

describe("readFileSync existence", () => {
  afterEach(() => _reset());

  it("answers ENOENT from the cache for a missing non-redirected path, no transport", () => {
    const deps = makeDeps();
    const fs = createFsSync(
      deps.metadataCache,
      deps.contentCache,
      deps.transport,
    );

    // Leading slash: normalize strips it, so resolved !== the raw argument.
    expect(() => fs.readFileSync("/.obsidian/backlink.json", "utf8")).toThrow(
      /ENOENT/,
    );
    expect(deps.transport.readFileSync).not.toHaveBeenCalled();
  });

  it("falls back to the original path for a redirected miss", () => {
    registerPathResolver(
      (p) => p === ".obsidian/workspace.json",
      () => ".obsidian/workspace.Work.json",
    );

    const deps = makeDeps();
    deps.transport.readFileSync = vi.fn((p) => {
      if (p === ".obsidian/workspace.Work.json") {
        const e = new Error("ENOENT");
        e.code = "ENOENT";
        throw e;
      }

      return "BASE";
    });

    const fs = createFsSync(
      deps.metadataCache,
      deps.contentCache,
      deps.transport,
    );

    // Returns the base content after the redirect target 404s: the fallback fired.
    expect(fs.readFileSync("/.obsidian/workspace.json", "utf8")).toBe("BASE");
    expect(deps.transport.readFileSync).toHaveBeenCalledWith(
      ".obsidian/workspace.Work.json",
      "utf8",
    );
  });
});
