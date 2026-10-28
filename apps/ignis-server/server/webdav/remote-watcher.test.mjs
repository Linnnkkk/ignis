import { describe, it, expect, vi, afterEach } from "vitest";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { watcher } = require("@ignis/server-core");
const { diff, pollOnce, start, stop, stopAll } = require("./remote-watcher.js");

afterEach(() => { stopAll(); vi.restoreAllMocks(); });

describe("remote WebDAV change polling", () => {
  it("delivers changes beyond the per-poll cap on subsequent polls", async () => {
    vi.spyOn(watcher, "hasListeners").mockReturnValue(true);
    const emit = vi.spyOn(watcher, "emitEvent").mockReturnValue(true);
    const tree = Object.fromEntries(Array.from({ length: 250 }, (_, n) => [
      `note-${n}.md`, { type: "file", size: 1, mtime: 1 },
    ]));
    const entry = { snapshot: new Map(), backend: { listTree: async () => ({ tree }) } };
    expect(await pollOnce("v", entry)).toMatchObject({ events: 200, remaining: 50 });
    expect(await pollOnce("v", entry)).toMatchObject({ events: 50, remaining: 0 });
    expect(new Set(emit.mock.calls.map((call) => call[1].path)).size).toBe(250);
  });

  it("does not advance its baseline when the last listener disconnects during polling", async () => {
    vi.spyOn(watcher, "hasListeners").mockReturnValueOnce(true).mockReturnValue(false);
    const emit = vi.spyOn(watcher, "emitEvent");
    const entry = {
      snapshot: new Map(),
      backend: { listTree: async () => ({ tree: { "new.md": { type: "file", size: 1, mtime: 1 } } }) },
    };
    expect(await pollOnce("v", entry)).toMatchObject({ skipped: true });
    expect(entry.snapshot.size).toBe(0);
    expect(emit).not.toHaveBeenCalled();
  });

  it("preserves the baseline on offline, authentication and truncated results, then reports recovery changes", async () => {
    vi.spyOn(watcher, "hasListeners").mockReturnValue(true);
    const emit = vi.spyOn(watcher, "emitEvent").mockReturnValue(true);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const baseline = new Map([["old.md", { type: "file", size: 1, mtime: 1, ctime: 1 }]]);
    const listTree = vi.fn().mockRejectedValueOnce(new Error("offline"))
      .mockRejectedValueOnce(new Error("401")).mockRejectedValueOnce(new Error("403"))
      .mockResolvedValueOnce({ tree: {}, stats: { truncated: true } })
      .mockResolvedValueOnce({ tree: { "new.md": { type: "file", size: 2, mtime: 2 } } });
    const entry = { snapshot: baseline, backend: { listTree } };
    for (let i = 0; i < 4; i++) {
      expect(await pollOnce("v", entry)).toHaveProperty("error");
      expect([...baseline.keys()]).toEqual(["old.md"]);
      expect(emit).not.toHaveBeenCalled();
    }
    expect(await pollOnce("v", entry)).toMatchObject({ events: 2 });
    expect(emit.mock.calls.map((call) => call[1].type)).toEqual(["created", "deleted"]);
  });

  it("seeds only after the first successful complete snapshot", async () => {
    vi.spyOn(watcher, "hasListeners").mockReturnValue(true);
    const emit = vi.spyOn(watcher, "emitEvent");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const listTree = vi.fn().mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({ tree: {}, stats: { truncated: true } })
      .mockResolvedValueOnce({ tree: { "existing.md": { type: "file", size: 1, mtime: 1 } } });
    const entry = await start("seed", { listTree });
    expect(entry.snapshot).toBeNull();
    expect(await pollOnce("seed", entry)).toHaveProperty("error");
    expect(entry.snapshot).toBeNull();
    expect(await pollOnce("seed", entry)).toMatchObject({ seeded: true, events: 0 });
    expect(entry.snapshot.has("existing.md")).toBe(true);
    expect(emit).not.toHaveBeenCalled();
  });

  it("detects a type change even if size and mtime are unchanged", () => {
    const previous = new Map([["path", { type: "file", size: 0, mtime: 0 }]]);
    const next = new Map([["path", { type: "directory", size: 0, mtime: 0 }]]);
    expect(diff(previous, next)).toMatchObject([{ type: "modified", path: "path" }]);
  });
});


describe("remote watcher shutdown races", () => {
  it("cannot install a timer after being stopped during its initial snapshot", async () => {
    let resolve;
    const listTree = vi.fn(() => new Promise((done) => { resolve = done; }));
    const starting = start("pending", { listTree });
    expect(stop("pending")).toBe(true);
    resolve({ tree: {} });
    const entry = await starting;
    expect(entry.stopped).toBe(true);
    expect(entry.timer).toBeNull();
    expect(stop("pending")).toBe(false);
  });

  it("does not emit a poll that finishes after stop even if listeners remain", async () => {
    vi.spyOn(watcher, "hasListeners").mockReturnValue(true);
    const emit = vi.spyOn(watcher, "emitEvent");
    let resolve;
    const backend = { listTree: vi.fn().mockResolvedValueOnce({ tree: {} })
      .mockImplementationOnce(() => new Promise((done) => { resolve = done; })) };
    const entry = await start("active", backend);
    const polling = pollOnce("active", entry);
    stop("active");
    resolve({ tree: { "late.md": { type: "file", size: 1, mtime: 1 } } });
    expect(await polling).toMatchObject({ skipped: true, events: 0 });
    expect(emit).not.toHaveBeenCalled();
    expect(entry.snapshot.size).toBe(0);
  });
});
