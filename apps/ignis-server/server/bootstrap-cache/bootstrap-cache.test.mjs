import {
  describe,
  it,
  expect,
  vi,
  afterAll,
  beforeEach,
  afterEach,
} from "vitest";
import { createRequire } from "module";
import path from "path";
import fs from "fs";
import os from "os";

const require = createRequire(import.meta.url);

const VAULT_ROOT = fs.mkdtempSync(
  path.join(os.tmpdir(), "bootstrap-cache-test-"),
);
process.env.VAULT_ROOT = VAULT_ROOT;

const VAULT_ID = "v";
const OTHER_ID = "w";
const vaultDir = path.join(VAULT_ROOT, VAULT_ID);
const otherDir = path.join(VAULT_ROOT, OTHER_ID);
fs.mkdirSync(vaultDir, { recursive: true });
fs.mkdirSync(otherDir, { recursive: true });

const config = require("../config");
config.refreshVaults();
const bootstrapCache = require("./index");
const { watcher } = require("@ignis/server-core");

const seed = (name, content) => {
  const abs = path.join(vaultDir, name);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function whenReady(entry) {
  return new Promise((resolve) => entry.watcher.on("ready", resolve));
}

function injectMidCrawl(fn) {
  const realReaddir = fs.promises.readdir;
  let injected = false;

  return vi
    .spyOn(fs.promises, "readdir")
    .mockImplementation(async (dir, opts) => {
      const entries = await realReaddir(dir, opts);

      if (!injected && path.resolve(dir) === path.resolve(vaultDir)) {
        injected = true;
        await fn();
      }

      return entries;
    });
}

beforeEach(() => {
  bootstrapCache.invalidateAll();
  fs.rmSync(vaultDir, { recursive: true, force: true });
  fs.mkdirSync(vaultDir, { recursive: true });
});

afterEach(async () => {
  await watcher._reset();
  vi.restoreAllMocks();
});

afterAll(() => {
  fs.rmSync(VAULT_ROOT, { recursive: true, force: true });
});

describe("watched and unwatched serving modes", () => {
  it("serves a watched vault's entry without stating its directories", async () => {
    seed("a.md", "a");

    const first = await bootstrapCache.getOrBuild(VAULT_ID);

    vi.spyOn(watcher, "isWatching").mockReturnValue(true);
    const statSpy = vi.spyOn(fs.promises, "stat");

    const second = await bootstrapCache.getOrBuild(VAULT_ID);

    expect(second).toBe(first);
    expect(statSpy).not.toHaveBeenCalled();
  });

  it("serves a watched vault's entry even when the vault changed on disk", async () => {
    seed("a.md", "a");

    const first = await bootstrapCache.getOrBuild(VAULT_ID);

    vi.spyOn(watcher, "isWatching").mockReturnValue(true);
    seed("late.md", "late");

    const second = await bootstrapCache.getOrBuild(VAULT_ID);

    expect(second).toBe(first);
    expect(second.response.tree["late.md"]).toBeUndefined();
  });

  it("revalidates an unwatched vault's directories on every request", async () => {
    seed("a.md", "a");

    const first = await bootstrapCache.getOrBuild(VAULT_ID);

    const statSpy = vi.spyOn(fs.promises, "stat");

    const second = await bootstrapCache.getOrBuild(VAULT_ID);

    expect(second).toBe(first);
    expect(statSpy).toHaveBeenCalledWith(vaultDir);
  });

  it("rebuilds an unwatched vault whose directory mtime moved", async () => {
    seed("a.md", "a");

    const first = await bootstrapCache.getOrBuild(VAULT_ID);

    // Windows directory mtime granularity is coarser than back-to-back writes.
    await sleep(50);
    seed("direct.md", "direct");

    const second = await bootstrapCache.getOrBuild(VAULT_ID);

    expect(second.response.tree["direct.md"]).toMatchObject({ type: "file" });
    expect(second.etag).not.toBe(first.etag);
  });
});

describe("invalidation", () => {
  it("rebuilds a watched vault on the next request", async () => {
    seed("a.md", "a");

    const first = await bootstrapCache.getOrBuild(VAULT_ID);

    vi.spyOn(watcher, "isWatching").mockReturnValue(true);
    seed("late.md", "late");
    bootstrapCache.invalidateVault(VAULT_ID);

    const second = await bootstrapCache.getOrBuild(VAULT_ID);

    expect(second.response.tree["late.md"]).toMatchObject({ type: "file" });
    expect(second.etag).not.toBe(first.etag);
  });

  it("drops the named vault and leaves the others cached", async () => {
    seed("a.md", "a");

    const firstV = await bootstrapCache.getOrBuild(VAULT_ID);
    const firstW = await bootstrapCache.getOrBuild(OTHER_ID);

    bootstrapCache.invalidateVault(VAULT_ID);

    const secondV = await bootstrapCache.getOrBuild(VAULT_ID);

    expect(secondV.etag).not.toBe(firstV.etag);
    expect(await bootstrapCache.getOrBuild(OTHER_ID)).toBe(firstW);
  });

  it("drops the compressed bodies with the entry", async () => {
    seed("a.md", "a");

    const first = await bootstrapCache.getOrBuild(VAULT_ID);

    bootstrapCache.invalidateVault(VAULT_ID);

    const second = await bootstrapCache.getOrBuild(VAULT_ID);

    expect(first.compressed.br).toBeInstanceOf(Buffer);
    expect(second.compressed.br).not.toBe(first.compressed.br);
  });

  it("invalidateAll drops every vault", async () => {
    seed("a.md", "a");

    const firstV = await bootstrapCache.getOrBuild(VAULT_ID);
    const firstW = await bootstrapCache.getOrBuild(OTHER_ID);

    bootstrapCache.invalidateAll();

    expect((await bootstrapCache.getOrBuild(VAULT_ID)).etag).not.toBe(
      firstV.etag,
    );
    expect((await bootstrapCache.getOrBuild(OTHER_ID)).etag).not.toBe(
      firstW.etag,
    );
  });

  it("serves but does not store a crawl an invalidation superseded", async () => {
    seed("a.md", "a");

    await bootstrapCache.getOrBuild(VAULT_ID);
    bootstrapCache.invalidateVault(VAULT_ID);

    const readdirSpy = injectMidCrawl(() => {
      seed("late.md", "late");
      bootstrapCache.invalidateVault(VAULT_ID); // as the watcher event would.
    });

    const served = await bootstrapCache.getOrBuild(VAULT_ID);

    readdirSpy.mockRestore();
    vi.spyOn(watcher, "isWatching").mockReturnValue(true);

    const next = await bootstrapCache.getOrBuild(VAULT_ID);

    expect(served.response.tree["late.md"]).toBeUndefined();
    expect(next).not.toBe(served);
    expect(next.response.tree["late.md"]).toMatchObject({ type: "file" });
  });

  it("serves but does not store a crawl invalidateAll superseded", async () => {
    seed("a.md", "a");

    const readdirSpy = injectMidCrawl(() => {
      seed("late.md", "late");
      bootstrapCache.invalidateAll();
    });

    const served = await bootstrapCache.getOrBuild(VAULT_ID);

    readdirSpy.mockRestore();
    vi.spyOn(watcher, "isWatching").mockReturnValue(true);

    const next = await bootstrapCache.getOrBuild(VAULT_ID);

    expect(served.response.tree["late.md"]).toBeUndefined();
    expect(next).not.toBe(served);
    expect(next.response.tree["late.md"]).toMatchObject({ type: "file" });
  });
});

describe("watcher-driven invalidation", () => {
  it("picks up a file a watcher event reported on a watched vault", async () => {
    seed("a.md", "a");

    watcher.addGlobalListener((vaultId) =>
      bootstrapCache.invalidateVault(vaultId),
    );

    const entry = watcher.startWatching(VAULT_ID, vaultDir);

    await whenReady(entry);

    expect(watcher.isWatching(VAULT_ID)).toBe(true);

    await bootstrapCache.getOrBuild(VAULT_ID);
    seed("late.md", "late");

    await vi.waitFor(
      async () => {
        const next = await bootstrapCache.getOrBuild(VAULT_ID);
        expect(next.response.tree["late.md"]).toMatchObject({ type: "file" });
      },
      { timeout: 8000 },
    );
  }, 20000);

  it("evicts the entry when the watcher is rebuilt", async () => {
    seed("a.md", "a");

    vi.spyOn(console, "warn").mockImplementation(() => {});
    watcher.onWatcherRebuild((vaultId) =>
      bootstrapCache.invalidateVault(vaultId),
    );

    const dead = watcher.startWatching(VAULT_ID, vaultDir);

    await whenReady(dead);

    const first = await bootstrapCache.getOrBuild(VAULT_ID);

    vi.spyOn(dead.watcher, "getWatched").mockReturnValue({});
    watcher.startWatching(VAULT_ID, vaultDir);

    const second = await bootstrapCache.getOrBuild(VAULT_ID);

    expect(second).not.toBe(first);
    expect(second.etag).not.toBe(first.etag);
  }, 20000);

  it("rejects until the vault root a rebuild was triggered by comes back", async () => {
    seed("a.md", "a");

    vi.spyOn(console, "warn").mockImplementation(() => {});
    watcher.onWatcherRebuild((vaultId) =>
      bootstrapCache.invalidateVault(vaultId),
    );

    const dead = watcher.startWatching(VAULT_ID, vaultDir);

    await whenReady(dead);
    await bootstrapCache.getOrBuild(VAULT_ID);

    fs.rmSync(vaultDir, { recursive: true, force: true });
    vi.spyOn(dead.watcher, "getWatched").mockReturnValue({});
    watcher.startWatching(VAULT_ID, vaultDir);

    await expect(bootstrapCache.getOrBuild(VAULT_ID)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(bootstrapCache.getOrBuild(VAULT_ID)).rejects.toMatchObject({
      code: "ENOENT",
    });

    fs.mkdirSync(vaultDir, { recursive: true });
    seed("reborn.md", "reborn");

    const healed = await bootstrapCache.getOrBuild(VAULT_ID);

    expect(healed.response.tree["reborn.md"]).toMatchObject({ type: "file" });
    expect(healed.response.tree["a.md"]).toBeUndefined();
  }, 20000);
});

describe("revalidation after a watcher start", () => {
  it("checks disk once, then short-circuits again", async () => {
    seed("a.md", "a");

    watcher.onWatcherStart((vaultId) =>
      bootstrapCache.markForRevalidation(vaultId),
    );

    const first = await bootstrapCache.getOrBuild(VAULT_ID);

    // Windows directory mtime granularity is coarser than back-to-back writes.
    await sleep(50);
    seed("offline.md", "offline");
    fs.rmSync(path.join(vaultDir, "a.md"));

    const entry = watcher.startWatching(VAULT_ID, vaultDir);

    await whenReady(entry);

    const served = await bootstrapCache.getOrBuild(VAULT_ID);

    expect(served).not.toBe(first);
    expect(served.response.tree["offline.md"]).toMatchObject({ type: "file" });
    expect(served.response.tree["a.md"]).toBeUndefined();

    const statSpy = vi.spyOn(fs.promises, "stat");

    const again = await bootstrapCache.getOrBuild(VAULT_ID);

    expect(again).toBe(served);
    expect(statSpy).not.toHaveBeenCalled();
  }, 20000);

  it("keeps the mark when the crawl it armed fails", async () => {
    seed("a.md", "a");

    const first = await bootstrapCache.getOrBuild(VAULT_ID);

    vi.spyOn(watcher, "isWatching").mockReturnValue(true);
    bootstrapCache.markForRevalidation(VAULT_ID);

    // Windows directory mtime granularity is coarser than back-to-back writes.
    await sleep(50);
    seed("offline.md", "offline");
    fs.rmSync(path.join(vaultDir, "a.md"));

    const readdirSpy = vi
      .spyOn(fs.promises, "readdir")
      .mockRejectedValueOnce(
        Object.assign(new Error("too many open files"), { code: "EMFILE" }),
      );

    await expect(bootstrapCache.getOrBuild(VAULT_ID)).rejects.toMatchObject({
      code: "EMFILE",
    });

    readdirSpy.mockRestore();

    const served = await bootstrapCache.getOrBuild(VAULT_ID);

    expect(served).not.toBe(first);
    expect(served.response.tree["offline.md"]).toMatchObject({ type: "file" });
    expect(served.response.tree["a.md"]).toBeUndefined();
  });
});

describe("warm-up", () => {
  it("shares an in-flight build with a concurrent request", async () => {
    seed("warm.md", "warm");

    const logs = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...args) => {
      logs.push(args.join(" "));
    });
    let warmed, requested;

    try {
      [, requested] = await Promise.all([
        bootstrapCache.warmUp(),
        bootstrapCache.getOrBuild(VAULT_ID),
      ]);
      warmed = await bootstrapCache.getOrBuild(VAULT_ID);
    } finally {
      spy.mockRestore();
    }

    expect(requested.response.tree["warm.md"]).toMatchObject({ type: "file" });
    expect(warmed).toBe(requested);
    expect(
      logs.filter((l) => l.includes(`vault=${VAULT_ID} build`)),
    ).toHaveLength(1);
  });
});
