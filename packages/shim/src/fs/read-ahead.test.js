import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createReadAhead } from "./read-ahead.js";
import { createFsPromises } from "./promises.js";
import { MetadataCache } from "./metadata-cache.js";
import { ContentCache } from "./content-cache.js";

const KB = 1024;

let metadataCache;
let contentCache;
let batchRequests;

function file(size = 100) {
  return { type: "file", size };
}

function batchAnswer(init) {
  const files = {};

  for (const p of JSON.parse(init.body).paths) {
    files[p] = "batch:" + p;
  }

  return { ok: true, json: async () => ({ files }) };
}

function holdBatches() {
  const held = [];

  globalThis.fetch = vi.fn((url, init) => {
    batchRequests.push(JSON.parse(init.body).paths);

    return new Promise((resolve) => {
      held.push({
        succeed: () => resolve(batchAnswer(init)),
        fail: () => resolve({ ok: false, status: 502 }),
      });
    });
  });

  return held;
}

beforeEach(() => {
  globalThis.window = { __currentVaultId: "v" };
  metadataCache = new MetadataCache();
  contentCache = new ContentCache();
  batchRequests = [];

  globalThis.fetch = vi.fn(async (url, init) => {
    batchRequests.push(JSON.parse(init.body).paths);
    return batchAnswer(init);
  });
});

afterEach(() => {
  delete globalThis.window;
  delete globalThis.fetch;
  vi.restoreAllMocks();
});

describe("the notes a cache miss fetches alongside", () => {
  it("takes the missed note's folder first, then the rest of the tree in order", async () => {
    metadataCache.populate({
      "a/1.md": file(),
      "b/1.md": file(),
      "b/missed.md": file(),
      "c/1.md": file(),
      "b/2.md": file(),
    });

    const readAhead = createReadAhead(metadataCache, contentCache);
    readAhead.fetchAround("b/missed.md");
    await readAhead.inFlightBatchFor("b/1.md");

    expect(batchRequests[0]).toEqual(["b/1.md", "b/2.md", "a/1.md", "c/1.md"]);
  });

  it("leaves out non-text, empty, oversized, plugin-asset, directory and cached paths", async () => {
    metadataCache.populate({
      "n/missed.md": file(),
      "n/picture.png": file(),
      "n/empty.md": file(0),
      "n/huge.md": file(600 * KB),
      ".obsidian/plugins/p/icons/a.svg": file(),
      "n/folder.md": { type: "directory" },
      "n/cached.md": file(),
      "n/keep.md": file(),
    });
    contentCache.set("n/cached.md", "cached");

    const readAhead = createReadAhead(metadataCache, contentCache);
    readAhead.fetchAround("n/missed.md");
    await readAhead.inFlightBatchFor("n/keep.md");

    expect(batchRequests[0]).toEqual(["n/keep.md"]);
  });

  it("leaves out notes another batch is already fetching", () => {
    holdBatches();
    metadataCache.populate({
      "n/first.md": file(),
      "n/second.md": file(),
      "n/a.md": file(),
      "n/b.md": file(),
    });

    const readAhead = createReadAhead(metadataCache, contentCache);
    readAhead.fetchAround("n/first.md");
    readAhead.fetchAround("n/second.md");

    expect(batchRequests[0]).toEqual(["n/second.md", "n/a.md", "n/b.md"]);
    expect(batchRequests[1]).toEqual(["n/first.md"]);
  });

  it("fetches at most 49 notes, the missed note's folder first", async () => {
    const tree = { "n/missed.md": file() };

    for (let i = 0; i < 30; i++) {
      tree[`m/${i}.md`] = file();
      tree[`n/${i}.md`] = file();
    }

    metadataCache.populate(tree);

    const readAhead = createReadAhead(metadataCache, contentCache);
    readAhead.fetchAround("n/missed.md");
    await readAhead.inFlightBatchFor("n/0.md");

    expect(batchRequests[0].length).toBe(49);
    expect(batchRequests[0].slice(0, 30).every((p) => p.startsWith("n/"))).toBe(
      true,
    );
  });
});

describe("read-ahead and the cache's free room", () => {
  function notes(count, size) {
    const tree = {};

    for (let i = 0; i < count; i++) {
      tree[`n/${i}.md`] = file(size);
    }

    return tree;
  }

  it("skips a batch that would not fit in the cache", () => {
    contentCache = new ContentCache(1000);
    metadataCache.populate(notes(5, 300));

    const readAhead = createReadAhead(metadataCache, contentCache);
    readAhead.fetchAround("n/0.md");

    expect(batchRequests).toEqual([]);
  });

  it("does not rescan the tree until the cache has room for the skipped batch", () => {
    contentCache = new ContentCache(1000);
    metadataCache.populate(notes(5, 300));
    const keys = vi.spyOn(metadataCache, "keys");

    const readAhead = createReadAhead(metadataCache, contentCache);
    readAhead.fetchAround("n/0.md");
    readAhead.fetchAround("n/1.md");

    expect(keys).toHaveBeenCalledTimes(1);
  });

  it("reads ahead again once the cache has room", async () => {
    contentCache = new ContentCache(1000);
    metadataCache.populate(notes(5, 300));

    const readAhead = createReadAhead(metadataCache, contentCache);
    readAhead.fetchAround("n/0.md");
    contentCache.setMaxSize(2000);
    readAhead.fetchAround("n/0.md");
    await readAhead.inFlightBatchFor("n/1.md");

    expect(batchRequests).toEqual([["n/1.md", "n/2.md", "n/3.md", "n/4.md"]]);
  });

  it("counts batches still in flight against the room", () => {
    holdBatches();
    contentCache = new ContentCache(1000);

    const tree = { "a/missed.md": file(100) };

    for (let i = 0; i < 50; i++) {
      tree[`a/${i}.md`] = file(10);
    }

    tree["b/missed.md"] = file(100);
    tree["b/1.md"] = file(300);
    tree["b/2.md"] = file(300);
    metadataCache.populate(tree);

    const readAhead = createReadAhead(metadataCache, contentCache);
    readAhead.fetchAround("a/missed.md");
    readAhead.fetchAround("b/missed.md");

    expect(batchRequests.length).toBe(1);
    expect(batchRequests[0].length).toBe(49);
  });
});

describe("readFile on a cache miss", () => {
  function setup(tree) {
    metadataCache.populate(tree);

    const transport = { readFile: vi.fn(async (p) => "own:" + p) };
    const fs = createFsPromises(metadataCache, contentCache, transport);

    return { fs, transport };
  }

  it("returns the missed note without waiting for its batch", async () => {
    holdBatches();
    const { fs } = setup({ "n/missed.md": file(), "n/next.md": file() });

    await expect(fs.readFile("n/missed.md", "utf8")).resolves.toBe(
      "own:n/missed.md",
    );
    expect(batchRequests).toEqual([["n/next.md"]]);
  });

  it("serves a note from the batch already fetching it, without its own request", async () => {
    const held = holdBatches();
    const { fs, transport } = setup({
      "n/missed.md": file(),
      "n/next.md": file(),
    });

    await fs.readFile("n/missed.md", "utf8");
    const next = fs.readFile("n/next.md", "utf8");
    held[0].succeed();

    await expect(next).resolves.toBe("batch:n/next.md");
    expect(transport.readFile).toHaveBeenCalledTimes(1);
  });

  it("falls back to its own request when the batch fails", async () => {
    const held = holdBatches();
    const { fs } = setup({ "n/missed.md": file(), "n/next.md": file() });

    await fs.readFile("n/missed.md", "utf8");
    const next = fs.readFile("n/next.md", "utf8");
    held[0].fail();

    await expect(next).resolves.toBe("own:n/next.md");
  });

  it("drops the batch copy of a note invalidated while the batch was in flight", async () => {
    const held = holdBatches();
    const { fs, transport } = setup({
      "n/missed.md": file(),
      "n/next.md": file(),
    });

    await fs.readFile("n/missed.md", "utf8");
    contentCache.invalidate("n/next.md");
    held[0].succeed();

    await expect(fs.readFile("n/next.md", "utf8")).resolves.toBe(
      "own:n/next.md",
    );
    expect(transport.readFile).toHaveBeenCalledTimes(2);
  });

  it("does not read ahead for a binary file", async () => {
    const { fs } = setup({ "n/picture.png": file(), "n/next.md": file() });

    await fs.readFile("n/picture.png");

    expect(batchRequests).toEqual([]);
  });
});
