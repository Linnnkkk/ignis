import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { prefetchVaultContent } from "./indexer-prefetch.js";
import { ContentCache } from "./content-cache.js";

const MB = 1024 * 1024;

// Every selection rule.
const tree = {
  ".obsidian/app.json": { type: "file", size: 100 },
  ".obsidian/community-plugins.json": { type: "file", size: 50 },
  ".obsidian/plugins/big/main.js": { type: "file", size: 2 * MB },
  ".obsidian/plugins/big/manifest.json": { type: "file", size: 80 },
  ".obsidian/plugins/big/styles.css": { type: "file", size: 200 },
  ".obsidian/plugins/big/data.json": { type: "file", size: 300 * 1024 },
  "Note.md": { type: "file", size: 100 },
  "Big.md": { type: "file", size: 600 * 1024 },
  "plugins/fake/main.js": { type: "file", size: 100 },
  somedir: { type: "directory" },
};

// Total bytes of the priority-slice files.
const PRIORITY_BYTES = 100 + 50 + 2 * MB + 80 + 200 + 300 * 1024;

let fetchCalls;

function makeCache() {
  const store = new Map();

  return {
    store,
    pathUpdates: () => 0,
    setFromServer: (path, content) => {
      store.set(path, content);
      return true;
    },
  };
}

function notes(count) {
  const t = {};

  for (let i = 0; i < count; i++) {
    t[`Note${i}.md`] = { type: "file", size: 100 };
  }

  return t;
}

function answer(init) {
  const files = {};

  for (const p of JSON.parse(init.body).paths) {
    files[p] = "content:" + p;
  }

  return { ok: true, json: async () => ({ files }) };
}

beforeEach(() => {
  fetchCalls = [];
  globalThis.fetch = vi.fn(async (url, init) => {
    const paths = JSON.parse(init.body).paths;
    fetchCalls.push(paths);

    const files = {};

    for (const p of paths) {
      files[p] = "content:" + p;
    }

    return { ok: true, json: async () => ({ files }) };
  });
});

afterEach(() => {
  vi.useRealTimers();
  delete globalThis.fetch;
  vi.restoreAllMocks();
});

describe("prefetchVaultContent fetching", () => {
  it("reports priority byte progress from zero up to the slice total", async () => {
    const onProgress = vi.fn();
    const result = prefetchVaultContent("v", tree, makeCache(), { onProgress });
    await result.priority;

    expect(onProgress).toHaveBeenCalledWith(0, PRIORITY_BYTES);
    expect(onProgress).toHaveBeenLastCalledWith(PRIORITY_BYTES, PRIORITY_BYTES);
  });

  it("caches returned content under its path", async () => {
    const cache = makeCache();
    const result = prefetchVaultContent("v", tree, cache);
    await result.bulk;

    expect(cache.store.get(".obsidian/app.json")).toBe(
      "content:.obsidian/app.json",
    );
    expect(cache.store.get("Note.md")).toBe("content:Note.md");
  });

  it("resolves both promises without fetching when there is no vault", async () => {
    const result = prefetchVaultContent("", tree, makeCache());

    await result.priority;
    await result.bulk;

    expect(fetchCalls.length).toBe(0);
  });

  it("resolves the priority promise even when a batch fails every attempt", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 500 }));

    const result = prefetchVaultContent("v", tree, makeCache());
    await vi.runAllTimersAsync();

    await expect(result.priority).resolves.toBeUndefined();
  });
});

describe("prefetchVaultContent parallel batching", () => {
  it("fetches every file across multiple batches and caches each exactly once", async () => {
    const many = {};

    for (let i = 0; i < 120; i++) {
      many[`Note${i}.md`] = { type: "file", size: 100 };
    }

    const cache = makeCache();
    const result = prefetchVaultContent("v", many, cache);
    await result.bulk;

    // 120 files / 50 per batch = 3 batches; each path is fetched once and cached.
    expect(fetchCalls.length).toBe(3);

    const allPaths = fetchCalls.flat();
    expect(allPaths.length).toBe(120);
    expect(new Set(allPaths).size).toBe(120);
    expect(cache.store.size).toBe(120);
  });

  it("retries a batch that fails once, and caches every file", async () => {
    vi.useFakeTimers();
    const many = notes(120);

    let calls = 0;
    globalThis.fetch = vi.fn(async (url, init) => {
      calls++;

      if (calls === 2) {
        return { ok: false, status: 502 };
      }

      return answer(init);
    });

    const cache = makeCache();
    const result = prefetchVaultContent("v", many, cache);
    await vi.runAllTimersAsync();

    await expect(result.bulk).resolves.toBeUndefined();
    expect(globalThis.fetch).toHaveBeenCalledTimes(4);
    expect(cache.store.size).toBe(120);
  });

  it("skips a batch that fails every attempt, and caches every other batch", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const many = notes(150);

    let failingAttempts = 0;
    globalThis.fetch = vi.fn(async (url, init) => {
      if (JSON.parse(init.body).paths.includes("Note50.md")) {
        failingAttempts++;
        return { ok: false, status: 502 };
      }

      return answer(init);
    });

    const cache = makeCache();
    const result = prefetchVaultContent("v", many, cache);
    await vi.runAllTimersAsync();

    await expect(result.bulk).resolves.toBeUndefined();
    expect(failingAttempts).toBe(4);
    expect(cache.store.size).toBe(100);
    expect(cache.store.has("Note0.md")).toBe(true);
    expect(cache.store.has("Note50.md")).toBe(false);
    expect(cache.store.has("Note149.md")).toBe(true);
    expect(warn).toHaveBeenCalledWith(
      "[ignis] Prefetch bulk batch failed:",
      "batch-read failed: 502",
    );
  });
});

describe("prefetchVaultContent racing a write", () => {
  const note = { "Note.md": { type: "file", size: 6 } };

  function holdBatch() {
    const held = {};

    globalThis.fetch = vi.fn(
      () =>
        new Promise((resolve) => {
          held.release = () =>
            resolve({
              ok: true,
              json: async () => ({ files: { "Note.md": "server" } }),
            });
        }),
    );

    return held;
  }

  it("keeps content written while the batch was in flight", async () => {
    const held = holdBatch();
    const cache = new ContentCache();
    const result = prefetchVaultContent("v", note, cache);

    await vi.waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
    cache.set("Note.md", "local");
    held.release();
    await result.bulk;

    expect(cache.get("Note.md")).toBe("local");
  });

  it("keeps content cached before the batch was sent", async () => {
    const held = holdBatch();
    const cache = new ContentCache();

    cache.set("Note.md", "local");

    const result = prefetchVaultContent("v", note, cache);

    await vi.waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
    held.release();
    await result.bulk;

    expect(cache.get("Note.md")).toBe("local");
  });
});
