import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from "vitest";
import { createRequire } from "module";
import path from "path";
import fs from "fs";
import os from "os";

const require = createRequire(import.meta.url);

const VAULT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "vault-route-"));
const DATA_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "vault-route-data-"));
process.env.VAULT_ROOT = VAULT_ROOT;
process.env.DATA_ROOT = DATA_ROOT;

const VAULT_ID = "v";
const RENAMED_ID = "w";
const OTHER_ID = "other";
const SETTINGS_FILE = path.join(DATA_ROOT, "server-settings.json");

const config = require("../config");
const settings = require("../settings");
const bootstrapCache = require("../cache");
const remoteVaults = require("../webdav/registry");
const vaultRouter = require("./vault");
const remoteWatcher = require("../webdav/remote-watcher");
const treeReconcile = require("../cache/reconcile");
const vaultFs = require("../webdav/vault-fs");
const lifecycle = require("../vault/lifecycle");
const { watcher } = require("@ignis/server-core");
const express = require("express");

let server;
let base;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.set("trust proxy", true);
  // Test-only source injection: exercise the socket guard without a LAN fixture.
  app.use((req, _res, next) => {
    Object.defineProperty(req.socket, "remoteAddress", {
      value: req.headers["x-test-peer"] || "::ffff:127.0.0.1", configurable: true,
    });
    next();
  });
  app.use("/api/vault", vaultRouter);
  app.use("/api/fs", require("./fs"));
  app.use("/api/bootstrap", require("./bootstrap"));

  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });

  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await watcher._reset();

  if (server) {
    server.close();
  }

  fs.rmSync(VAULT_ROOT, { recursive: true, force: true });
  fs.rmSync(DATA_ROOT, { recursive: true, force: true });
});

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});

  for (const entry of fs.readdirSync(VAULT_ROOT)) {
    fs.rmSync(path.join(VAULT_ROOT, entry), { recursive: true, force: true });
  }

  fs.mkdirSync(path.join(VAULT_ROOT, VAULT_ID), { recursive: true });
  config.refreshVaults();
  settings.update({ trustedVaults: [] });
  fs.rmSync(SETTINGS_FILE, { force: true });
});

afterEach(() => {
  remoteWatcher.stopAll();
  lifecycle.setWss(null);
  vi.restoreAllMocks();
});

const rename = (vault, name) =>
  fetch(`${base}/api/vault/rename`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ vault, name }),
  });

const remove = (vault) =>
  fetch(`${base}/api/vault/remove?vault=${encodeURIComponent(vault)}`, {
    method: "DELETE",
  });

const refresh = (vault) =>
  fetch(`${base}/api/vault/refresh`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ vault }),
  });

describe("manual refresh", () => {
  it("serves a refresh right after an ordinary crawl", async () => {
    await bootstrapCache.getOrBuild(VAULT_ID);

    expect((await refresh(VAULT_ID)).status).toBe(200);
  });

  it("refuses a second refresh within the cooldown", async () => {
    fs.mkdirSync(path.join(VAULT_ROOT, OTHER_ID), { recursive: true });
    config.refreshVaults();

    expect((await refresh(OTHER_ID)).status).toBe(200);
    expect((await refresh(OTHER_ID)).status).toBe(429);
  });
});

describe("WebDAV vault management", () => {
  it.each([
    ["rename", () => rename(VAULT_ID, RENAMED_ID), "Renaming"],
    ["remove", () => remove(VAULT_ID), "Removing"],
  ])("rejects %s without touching the placeholder or settings", async (_operation, request, verb) => {
    const placeholder = path.join(VAULT_ROOT, VAULT_ID);
    const marker = path.join(placeholder, "local-marker.txt");
    fs.writeFileSync(marker, "keep");
    settings.update({ trustedVaults: [VAULT_ID] });
    vi.spyOn(remoteVaults, "isRemoteVault").mockReturnValue(true);
    const renameSpy = vi.spyOn(fs.promises, "rename");
    const rmSpy = vi.spyOn(fs.promises, "rm");

    const res = await request();

    expect(res.status).toBe(501);
    expect(await res.json()).toEqual({ error: `${verb} WebDAV vaults is not supported` });
    expect(fs.readFileSync(marker, "utf8")).toBe("keep");
    expect(fs.existsSync(path.join(VAULT_ROOT, RENAMED_ID))).toBe(false);
    expect(settings.get("trustedVaults")).toEqual([VAULT_ID]);
    expect(renameSpy).not.toHaveBeenCalled();
    expect(rmSpy).not.toHaveBeenCalled();
  });
});

describe("trusted vaults through the vault routes", () => {
  it("reports trust on the vault info fallback", async () => {
    settings.update({ trustedVaults: [VAULT_ID] });

    const info = await (
      await fetch(`${base}/api/vault/info?vault=${VAULT_ID}`)
    ).json();

    expect(info.trustPlugins).toBe(true);
    expect(info.id).toBe(VAULT_ID);
  });

  it("moves a renamed vault's id and keeps the other ids in place", async () => {
    settings.update({ trustedVaults: [VAULT_ID, OTHER_ID] });

    const res = await rename(VAULT_ID, RENAMED_ID);

    expect(res.status).toBe(200);
    expect(settings.get("trustedVaults")).toEqual([RENAMED_ID, OTHER_ID]);
  });

  it("drops a removed vault's id and keeps the other ids in place", async () => {
    settings.update({ trustedVaults: [VAULT_ID, OTHER_ID] });

    const res = await remove(VAULT_ID);

    expect(res.status).toBe(200);
    expect(settings.get("trustedVaults")).toEqual([OTHER_ID]);
  });

  it("writes no settings file when an untrusted vault is renamed", async () => {
    const res = await rename(VAULT_ID, RENAMED_ID);

    expect(res.status).toBe(200);
    expect(fs.existsSync(SETTINGS_FILE)).toBe(false);
  });

  it("writes no settings file when an untrusted vault is removed", async () => {
    const res = await remove(VAULT_ID);

    expect(res.status).toBe(200);
    expect(fs.existsSync(SETTINGS_FILE)).toBe(false);
  });
});


describe("runtime WebDAV disable", () => {
  const disable = (headers = {}) => fetch(`${base}/api/vault/webdav/disable`, { method: "POST", headers });

  function mount() {
    process.env.VITREUS_WEBDAV_RUNTIME = JSON.stringify({ vaults: [
      { id: "remote-a", url: "https://example.test/dav/a" },
      { id: "remote-b", url: "https://example.test/dav/b" },
    ] });
    remoteVaults.load({ vaultRoot: VAULT_ROOT, dataRoot: DATA_ROOT });
    config.refreshVaults();
    return remoteVaults.list();
  }

  it.each(["192.168.0.22", "::ffff:192.168.0.22", "203.0.113.1"])("rejects peer %s even with spoofed loopback forwarding", async (peer) => {
    mount();
    const res = await disable({ "x-test-peer": peer, "x-forwarded-for": "127.0.0.1" });
    expect(res.status).toBe(403);
    expect(remoteVaults.list()).toHaveLength(2);
  });

  it("rejects browser-origin management", async () => {
    mount();
    expect((await disable({ origin: "http://localhost" })).status).toBe(403);
    expect(remoteVaults.list()).toHaveLength(2);
  });

  it.each(["127.0.0.1", "::1", "::ffff:127.0.0.1"])("revokes all mounts and lifecycle work from %s without touching placeholder data", async (peer) => {
    const mounts = mount();
    const cancel = vi.spyOn(treeReconcile, "cancelVault");
    const invalidate = vi.spyOn(bootstrapCache, "invalidateVault");
    const stop = vi.spyOn(remoteWatcher, "stop");
    const stopWatching = vi.spyOn(watcher, "stopWatching");
    const close = vi.fn();
    lifecycle.setWss({ closeVaultSockets: close });
    for (const { vaultId, dir } of mounts) {
      fs.writeFileSync(path.join(dir, "marker.md"), "keep");
      await remoteWatcher.start(vaultId, { listTree: async () => ({ tree: {} }) });
    }
    const res = await disable({ "x-test-peer": peer, "x-forwarded-for": "192.168.0.22" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, disabled: ["remote-a", "remote-b"], localVault: VAULT_ID });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(remoteVaults.list()).toEqual([]);
    for (const { vaultId, dir } of mounts) {
      expect(cancel).toHaveBeenCalledWith(vaultId);
      expect(invalidate).toHaveBeenCalledWith(vaultId);
      expect(stop).toHaveBeenCalledWith(vaultId);
      expect(stopWatching).toHaveBeenCalledWith(vaultId);
      expect(close).toHaveBeenCalledWith(vaultId);
      expect(config.getVaultPathOrRescan(vaultId, Date.now() + 2000)).toBeNull();
      expect(fs.readFileSync(path.join(dir, "marker.md"), "utf8")).toBe("keep");
      expect((await fetch(`${base}/api/vault/info?vault=${vaultId}`)).status).toBe(404);
      expect((await fetch(`${base}/api/bootstrap?vault=${vaultId}`)).status).toBe(404);
      expect((await fetch(`${base}/api/fs/readFile?vault=${vaultId}&path=marker.md`)).status).toBe(404);
      expect((await fetch(`${base}/api/fs/writeFile`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ vault: vaultId, path: "new.md", data: "bad" }) })).status).toBe(404);
      await expect(vaultFs.promises.readFile(path.join(dir, "marker.md"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(vaultFs.promises.writeFile(path.join(dir, "new.md"), "bad")).rejects.toMatchObject({ code: "ENOENT" });
      await expect(vaultFs.promises.copyFile(path.join(VAULT_ROOT, VAULT_ID, "local.md"), path.join(dir, "new.md"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(fs.existsSync(path.join(dir, "new.md"))).toBe(false);
    }
    expect(await (await disable()).json()).toEqual({ ok: true, disabled: [], localVault: VAULT_ID });
    expect((await fetch(`${base}/api/vault/info?vault=${VAULT_ID}`)).status).toBe(200);
  });

  it("returns an empty localVault when no local vault exists", async () => {
    mount();
    fs.rmSync(path.join(VAULT_ROOT, VAULT_ID), { recursive: true });
    expect(await (await disable()).json()).toEqual({ ok: true, disabled: ["remote-a", "remote-b"], localVault: "" });
  });
});
