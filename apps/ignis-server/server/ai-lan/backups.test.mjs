import { afterEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const { createBackupStore, MAX_CONTENT_BYTES, MAX_TOTAL_BYTES, MAX_BACKUPS } = require("./backups.js");
const roots = [];
const binding = { vaultId: "main", path: "目录/note.md" };
const snapshot = { ...binding, content: "原始笔记\n", revision: '"test-revision"' };

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ignis-backup-test-"));
  roots.push(root);
  const dataDir = path.join(root, "private");
  const store = createBackupStore(dataDir);
  return { root, dataDir, dir: path.join(dataDir, "backups"), store };
}

function expectCode(fn, code) {
  expect(fn).toThrow(expect.objectContaining({ code }));
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    // Only test-owned mkdtemp roots; never follows a symlink recursively.
    if (!path.isAbsolute(root) || !path.basename(root).startsWith("ignis-backup-test-")) throw new Error("Unsafe cleanup");
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("private AI backup store", () => {
  it("round trips content and revision through CJS, persists restart and exposes metadata only in list", async () => {
    const { root, dataDir, store } = setup();
    const vault = path.join(root, "vault");
    fs.mkdirSync(vault);
    const saved = await store.save(snapshot);
    expect(saved).toEqual({ ...binding, revision: snapshot.revision, backupId: expect.stringMatching(/^[0-9a-f]{32}$/), createdAt: expect.any(Number), bytes: Buffer.byteLength(snapshot.content) });
    const restarted = createBackupStore(dataDir);
    expect(await restarted.list(binding)).toEqual([saved]);
    expect(await restarted.read({ ...binding, backupId: saved.backupId })).toEqual({ ...saved, content: snapshot.content });
    expect(fs.readdirSync(vault)).toEqual([]);
    expect(Object.keys(store).sort()).toEqual(["list", "read", "save"]);
  });

  it("uses private permissions, unique unpredictable IDs, and newest-first ordering", () => {
    const { dataDir, dir, store } = setup();
    vi.spyOn(Date, "now").mockReturnValueOnce(100).mockReturnValueOnce(200);
    const first = store.save(snapshot);
    const second = store.save(snapshot);
    expect(first.backupId).not.toBe(second.backupId);
    expect(store.list(binding).map((item) => item.backupId)).toEqual([second.backupId, first.backupId]);
    for (const folder of [dataDir, dir]) expect(fs.statSync(folder).mode & 0o777).toBe(0o700);
    expect(fs.readdirSync(dir).sort()).toEqual([`${first.backupId}.json`, `${second.backupId}.json`].sort());
    for (const name of fs.readdirSync(dir)) expect(fs.statSync(path.join(dir, name)).mode & 0o777).toBe(0o600);
  });

  it("binds lookup to both vault and exact path, without leaking cross-binding content", () => {
    const { store } = setup();
    const saved = store.save(snapshot);
    for (const other of [{ ...binding, vaultId: "other" }, { ...binding, path: "other.md" }]) {
      expect(store.list(other)).toEqual([]);
      expectCode(() => store.read({ ...other, backupId: saved.backupId }), "BACKUP_NOT_FOUND");
    }
    expectCode(() => store.read({ ...binding, backupId: "a".repeat(32) }), "BACKUP_NOT_FOUND");
  });

  it("rejects path injection and malformed inputs before creating storage", () => {
    const { dir, store } = setup();
    for (const notePath of ["/absolute.md", "../x", "x/../y", "x/./y", "x//y", "x/", "C:/x", "x\\y", "x\0y", "%2e%2e/x", "x/%2f/y", ""]) {
      for (const action of ["save", "list", "read"]) expectCode(() => store[action]({ ...snapshot, path: notePath, backupId: "a".repeat(32) }), "INVALID_ARGUMENT");
    }
    for (const vaultId of ["../x", "/x", "..", "x\\y", "x\0y", ""]) expectCode(() => store.save({ ...snapshot, vaultId }), "INVALID_ARGUMENT");
    for (const backupId of ["../x", "a".repeat(31), "A".repeat(32), null]) expectCode(() => store.read({ ...binding, backupId }), "INVALID_ARGUMENT");
    for (const patch of [{ content: Buffer.from("x") }, { revision: undefined }, { revision: "r".repeat(1025) }]) expectCode(() => store.save({ ...snapshot, ...patch }), "INVALID_ARGUMENT");
    expect(fs.existsSync(dir)).toBe(false);
  });

  it("limits content by UTF-8 bytes at exactly 1 MiB", () => {
    const { store } = setup();
    const content = "a".repeat(MAX_CONTENT_BYTES);
    const saved = store.save({ ...snapshot, content });
    expect(store.read({ ...binding, backupId: saved.backupId }).content).toBe(content);
    expectCode(() => store.save({ ...snapshot, content: `${content}a` }), "BACKUP_TOO_LARGE");
    expectCode(() => store.save({ ...snapshot, content: "汉".repeat(Math.ceil(MAX_CONTENT_BYTES / 3)) }), "BACKUP_TOO_LARGE");
    expect(store.list(binding)).toHaveLength(1);
  });

  it("caps physical JSON bytes globally across vaults and never evicts existing records", () => {
    const { dir, store } = setup();
    const content = "\0".repeat(MAX_CONTENT_BYTES); // JSON escaping counts toward physical quota.
    const saved = [];
    for (let i = 0; i < 5; i++) saved.push(store.save({ ...snapshot, vaultId: `vault${i}`, content }));
    expectCode(() => store.save({ ...snapshot, vaultId: "sixth", content }), "BACKUP_STORE_FULL");
    const files = fs.readdirSync(dir);
    expect(files).toHaveLength(5);
    expect(files.reduce((sum, name) => sum + fs.statSync(path.join(dir, name)).size, 0)).toBeLessThanOrEqual(MAX_TOTAL_BYTES);
    expect(store.read({ ...binding, vaultId: "vault0", backupId: saved[0].backupId }).content).toBe(content);
  });

  it("bounds even empty snapshots by a global record count", () => {
    const { dir, store } = setup();
    const saved = store.save({ ...snapshot, content: "" });
    const record = JSON.parse(fs.readFileSync(path.join(dir, `${saved.backupId}.json`), "utf8"));
    // Seed valid synthetic snapshots directly to avoid O(n²) quota rescans in fixture construction.
    for (let i = 0; i < MAX_BACKUPS - 1; i++) {
      const backupId = i.toString(16).padStart(32, "0");
      fs.writeFileSync(path.join(dir, `${backupId}.json`), JSON.stringify({ ...record, backupId }), { mode: 0o600, flag: "wx" });
    }
    expectCode(() => store.save({ ...snapshot, content: "" }), "BACKUP_STORE_FULL");
    expect(fs.readdirSync(dir)).toHaveLength(MAX_BACKUPS);
  }, 15000);

  it("rejects a symbolic-link storage root and any symbolic-link ancestor", () => {
    const { root, dataDir, store } = setup();
    const outside = path.join(root, "outside");
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, dataDir);
    expectCode(() => store.save(snapshot), "BACKUP_STORE_UNSAFE");
    const nested = createBackupStore(path.join(dataDir, "nested"));
    expectCode(() => nested.list(binding), "BACKUP_STORE_UNSAFE");
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it("rejects symlink/hardlink/nonprivate snapshot entries without exposing their data", () => {
    const { root, dir, store } = setup();
    const saved = store.save(snapshot);
    const filename = path.join(dir, `${saved.backupId}.json`);
    const outside = path.join(root, "outside.json");
    fs.renameSync(filename, outside);
    fs.symlinkSync(outside, filename);
    expectCode(() => store.read({ ...binding, backupId: saved.backupId }), "BACKUP_STORE_UNSAFE");
    expectCode(() => store.save(snapshot), "BACKUP_STORE_UNSAFE");
    fs.unlinkSync(filename);
    fs.linkSync(outside, filename);
    expectCode(() => store.list(binding), "BACKUP_STORE_UNSAFE");
    fs.unlinkSync(filename);
    fs.copyFileSync(outside, filename);
    fs.chmodSync(filename, 0o644);
    expectCode(() => store.list(binding), "BACKUP_STORE_UNSAFE");
  });

  it("writes a private temporary file then atomically renames; cleans up failed writes", () => {
    const { dir, store } = setup();
    const rename = fs.renameSync;
    const spy = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      expect(path.dirname(from)).toBe(dir);
      expect(path.basename(from)).toMatch(/^\.[a-f0-9]{32}\.tmp$/);
      expect(fs.statSync(from).mode & 0o777).toBe(0o600);
      expect(fs.existsSync(to)).toBe(false);
      return rename(from, to);
    });
    const saved = store.save(snapshot);
    expect(spy).toHaveBeenCalledOnce();
    spy.mockImplementation(() => { throw Object.assign(new Error("test disk failure"), { code: "EIO" }); });
    expectCode(() => store.save(snapshot), "EIO");
    expect(fs.readdirSync(dir)).toEqual([`${saved.backupId}.json`]);
    expect(store.list(binding)).toHaveLength(1);
  });

  it("fails closed on lock contention and stale temp files, without deleting them", () => {
    const { dir, store } = setup();
    store.list(binding);
    const lock = path.join(dir, ".lock");
    fs.writeFileSync(lock, "", { mode: 0o600 });
    expectCode(() => store.save(snapshot), "BACKUP_STORE_BUSY");
    fs.unlinkSync(lock);
    const stale = path.join(dir, ".stale.tmp");
    fs.writeFileSync(stale, "test", { mode: 0o600 });
    expectCode(() => store.save(snapshot), "BACKUP_STORE_UNSAFE");
    expect(fs.readFileSync(stale, "utf8")).toBe("test");
  });

  it("rejects corrupt, replaced-binding and oversized on-disk records", () => {
    const { dir, store } = setup();
    const saved = store.save(snapshot);
    const filename = path.join(dir, `${saved.backupId}.json`);
    const original = fs.readFileSync(filename, "utf8");
    fs.writeFileSync(filename, "{", { mode: 0o600 });
    expectCode(() => store.list(binding), "BACKUP_STORE_UNSAFE");
    const changed = JSON.parse(original);
    changed.vaultId = "other";
    fs.writeFileSync(filename, JSON.stringify(changed));
    expectCode(() => store.read({ ...binding, backupId: saved.backupId }), "BACKUP_NOT_FOUND");
    fs.truncateSync(filename, MAX_TOTAL_BYTES + 1);
    expectCode(() => store.list(binding), "BACKUP_STORE_UNSAFE");
  });
});
