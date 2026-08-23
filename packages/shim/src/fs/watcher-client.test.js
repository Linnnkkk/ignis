import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createWatcherClient } from "./watcher-client.js";
import { markLocalOp } from "./echo-guard.js";
import { MetadataCache } from "./metadata-cache.js";

const RESYNC_DEBOUNCE_MS = 1000;

function makeDeps(metadataOverride) {
  const store = new Map();

  const metadataCache = metadataOverride || {
    get: (p) => store.get(p) || null,
    set: (p, m) => store.set(p, m),
    delete: (p) => store.delete(p),
    has: (p) => store.has(p),
    keys: () => [...store.keys()],
  };

  const contentCache = {
    invalidate: vi.fn(),
    set: vi.fn(),
    delete: vi.fn(),
    get: () => null,
  };

  const fsWatch = { _dispatch: vi.fn() };
  const wsClient = { subscribe: vi.fn(), onOpen: vi.fn() };
  const transport = { fetchTree: vi.fn() };

  const client = createWatcherClient(
    metadataCache,
    contentCache,
    fsWatch,
    wsClient,
    transport,
  );

  return {
    store,
    metadataCache,
    contentCache,
    fsWatch,
    wsClient,
    transport,
    client,
  };
}

describe("watcher-client reconcile", () => {
  it("adds a file present in the tree but missing from the cache", () => {
    const d = makeDeps();

    d.client.reconcile({
      "new.md": { type: "file", size: 5, mtime: 100, ctime: 50 },
    });

    expect(d.store.get("new.md")).toMatchObject({ type: "file", size: 5 });
    expect(d.contentCache.invalidate).toHaveBeenCalledWith("new.md");
    expect(d.fsWatch._dispatch).toHaveBeenCalledWith("created", "new.md");
  });

  it("adds a directory as a folder", () => {
    const d = makeDeps();

    d.client.reconcile({ newdir: { type: "directory" } });

    expect(d.store.get("newdir")).toEqual({ type: "directory" });
    expect(d.fsWatch._dispatch).toHaveBeenCalledWith(
      "folder-created",
      "newdir",
    );
  });

  it("modifies a file whose mtime or size changed", () => {
    const d = makeDeps();
    d.store.set("a.md", { type: "file", size: 1, mtime: 10 });

    d.client.reconcile({
      "a.md": { type: "file", size: 2, mtime: 20, ctime: 5 },
    });

    expect(d.store.get("a.md")).toMatchObject({ size: 2, mtime: 20 });
    expect(d.fsWatch._dispatch).toHaveBeenCalledWith("modified", "a.md");
  });

  it("is a no-op for an unchanged file", () => {
    const d = makeDeps();
    d.store.set("a.md", { type: "file", size: 1, mtime: 10 });

    d.client.reconcile({
      "a.md": { type: "file", size: 1, mtime: 10, ctime: 5 },
    });

    expect(d.fsWatch._dispatch).not.toHaveBeenCalled();
  });

  it("deletes a cache entry absent from the tree and preserves the root", () => {
    const d = makeDeps();
    d.store.set("", { type: "directory" });
    d.store.set("gone.md", { type: "file", size: 1, mtime: 10 });
    d.store.set("keep.md", { type: "file", size: 1, mtime: 10 });

    d.client.reconcile({
      "keep.md": { type: "file", size: 1, mtime: 10, ctime: 5 },
    });

    expect(d.store.has("gone.md")).toBe(false);
    expect(d.store.has("")).toBe(true);
    expect(d.fsWatch._dispatch).toHaveBeenCalledWith("deleted", "gone.md");
    expect(d.fsWatch._dispatch).not.toHaveBeenCalledWith("deleted", "keep.md");
  });

  it("skips a path with a recent local op", () => {
    const d = makeDeps();
    const p = "recent-local-op-reconcile.md";
    markLocalOp(p);

    d.client.reconcile({
      [p]: { type: "file", size: 5, mtime: 100, ctime: 50 },
    });

    expect(d.store.has(p)).toBe(false);
    expect(d.fsWatch._dispatch).not.toHaveBeenCalled();
  });
});

describe("watcher-client resync", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const scheduleResyncOf = (d) => d.wsClient.onOpen.mock.calls[0][0];

  it("skips reconcile when the server reports the tree is not modified", async () => {
    const d = makeDeps();
    d.transport.fetchTree.mockResolvedValue({ notModified: true, etag: '"1"' });

    scheduleResyncOf(d)();
    await vi.advanceTimersByTimeAsync(RESYNC_DEBOUNCE_MS);

    expect(d.transport.fetchTree).toHaveBeenCalledWith(null);
    expect(d.fsWatch._dispatch).not.toHaveBeenCalled();
  });

  it("reconciles the tree and sends the stored revision on the next resync", async () => {
    const d = makeDeps();
    d.transport.fetchTree
      .mockResolvedValueOnce({
        tree: { "fresh.md": { type: "file", size: 3, mtime: 1, ctime: 1 } },
        etag: '"2"',
      })
      .mockResolvedValueOnce({ notModified: true, etag: '"2"' });

    const scheduleResync = scheduleResyncOf(d);

    scheduleResync();
    await vi.advanceTimersByTimeAsync(RESYNC_DEBOUNCE_MS);

    expect(d.store.get("fresh.md")).toMatchObject({ type: "file", size: 3 });
    expect(d.fsWatch._dispatch).toHaveBeenCalledWith("created", "fresh.md");

    scheduleResync();
    await vi.advanceTimersByTimeAsync(RESYNC_DEBOUNCE_MS);

    expect(d.transport.fetchTree).toHaveBeenLastCalledWith('"2"');
  });
});

describe("watcher-client repopulation after a stale-tree delete", () => {
  const LIVE = { type: "file", size: 12, mtime: 1000, ctime: 900 };
  const STALE_TREE = {
    "other.md": { type: "file", size: 1, mtime: 5, ctime: 5 },
  };
  const FRESH_TREE = {
    ...STALE_TREE,
    "live.md": { type: "file", size: 12, mtime: 1000, ctime: 900 },
  };

  function seeded() {
    const cache = new MetadataCache();

    cache.set("live.md", { ...LIVE });

    return { cache, d: makeDeps(cache) };
  }

  function handlerOf(d, type) {
    return d.wsClient.subscribe.mock.calls.find((c) => c[0] === type)[1];
  }

  function expectLive(cache) {
    const stat = cache.toStat("live.md");

    expect(cache.has("live.md")).toBe(true);
    expect(cache.get("live.md")).toMatchObject({ type: "file" });
    expect(stat.isFile()).toBe(true);
    expect(stat.isDirectory()).toBe(false);
    expect(stat.size).toBe(12);
    expect(stat.mtimeMs).toBe(1000);
    expect(stat.ctimeMs).toBe(900);
  }

  it("repopulates from the watcher event that follows the delete", () => {
    const { cache, d } = seeded();

    d.client.reconcile(STALE_TREE);

    expect(cache.has("live.md")).toBe(false);
    expect(cache.toStat("live.md")).toBeNull();
    expect(d.fsWatch._dispatch).toHaveBeenCalledWith("deleted", "live.md");

    const onModified = handlerOf(d, "modified");

    onModified({
      path: "live.md",
      stat: { size: 12, mtime: 1000, ctime: 900 },
    });

    expectLive(cache);
    expect(d.fsWatch._dispatch).toHaveBeenCalledWith("modified", "live.md");
    expect(d.contentCache.invalidate).toHaveBeenCalledWith("live.md");
  });

  it("repopulates from a create event when the path is recreated on disk", () => {
    const { cache, d } = seeded();

    d.client.reconcile(STALE_TREE);

    const onCreated = handlerOf(d, "created");

    onCreated({ path: "live.md", stat: { size: 12, mtime: 1000, ctime: 900 } });

    expectLive(cache);
  });

  describe("through a resync", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("repopulates once the server tree carries the path again", async () => {
      const { cache, d } = seeded();

      d.transport.fetchTree
        .mockResolvedValueOnce({ tree: STALE_TREE, etag: '"stale"' })
        .mockResolvedValueOnce({ tree: FRESH_TREE, etag: '"fresh"' });

      const scheduleResync = d.wsClient.onOpen.mock.calls[0][0];

      scheduleResync();
      await vi.advanceTimersByTimeAsync(RESYNC_DEBOUNCE_MS);

      expect(cache.has("live.md")).toBe(false);

      scheduleResync();
      await vi.advanceTimersByTimeAsync(RESYNC_DEBOUNCE_MS);

      expectLive(cache);
      expect(d.transport.fetchTree).toHaveBeenLastCalledWith('"stale"');
    });

    it("leaves the path deleted while the server repeats that tree revision", async () => {
      const { cache, d } = seeded();

      d.transport.fetchTree
        .mockResolvedValueOnce({ tree: STALE_TREE, etag: '"stale"' })
        .mockResolvedValueOnce({ notModified: true, etag: '"stale"' });

      const scheduleResync = d.wsClient.onOpen.mock.calls[0][0];

      scheduleResync();
      await vi.advanceTimersByTimeAsync(RESYNC_DEBOUNCE_MS);

      scheduleResync();
      await vi.advanceTimersByTimeAsync(RESYNC_DEBOUNCE_MS);

      expect(cache.has("live.md")).toBe(false);
    });
  });
});
