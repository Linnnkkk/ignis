import { afterEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import https from "node:https";
import dgram from "node:dgram";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const { createAiLanService } = require("./index.js");

const roots = [];
const services = [];

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ignis-ai-lan-"));
  roots.push(root);
  const vault = path.join(root, "vault");
  fs.mkdirSync(vault);
  const notes = Object.create(null);
  notes.main = vault;
  const config = {
    dataRoot: path.join(root, "data"),
    vaults: notes,
    getVaultPath: (id) => Object.prototype.hasOwnProperty.call(notes, id) ? notes[id] : null,
  };
  const cache = { applyMutation: vi.fn(async () => '"revision"') };
  const writeCoalescer = { flushPending: vi.fn(async () => false), getPending: vi.fn(() => null), pendingBuffer: (data, encoding) => Buffer.isBuffer(data) ? data : Buffer.from(data, encoding === "binary" ? "utf8" : encoding) };
  const service = createAiLanService({ config, bootstrapCache: cache, writeCoalescer });
  service.setAccess({ vaultIds: ['main'], allowWrite: true });
  services.push(service);
  return { root, vault, service, cache, writeCoalescer };
}

function request(port, cert, pathname, { method = "POST", body, token, agent } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = https.request({
      hostname: "localhost",
      port,
      path: pathname,
      method,
      ca: cert,
      agent,
      headers: {
        ...(data ? { "content-type": "application/json", "content-length": data.length } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }));
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

async function start(ctx) {
  const status = await ctx.service.enable({ ips: ["127.0.0.1"] });
  const cert = fs.readFileSync(path.join(ctx.root, "data", "ai-lan", "tls", "cert.pem"), "utf8");
  expect(status.fingerprint).toBeTruthy();
  return { status, cert };
}

async function pair(ctx, port, cert, pairingCode) {
  const result = await request(port, cert, "/pair", { body: { clientName: "test client", pairingCode } });
  expect(result.status).toBe(200);
  expect(result.body.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  return result.body.token;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(services.splice(0).map((service) => service.disable().catch(() => {})));
  roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true }));
});

describe("AI-LAN service", () => {
  it("uses pinned HTTPS, exchanges a pairing code and authenticates RPC without Origin", async () => {
    const ctx = setup();
    const { status, cert } = await start(ctx);
    const pairing = ctx.service.createPairing();
    expect(pairing).toEqual({
      version: 1,
      deviceId: status.deviceId,
      address: "127.0.0.1",
      port: status.port,
      fingerprint: status.fingerprint,
      pairingCode: expect.any(String),
      pairingExpiresAt: expect.any(Number),
    });
    expect(ctx.service.status()).not.toHaveProperty("pairingCode");
    const token = await pair(ctx, status.port, cert, pairing.pairingCode);
    const response = await request(status.port, cert, "/rpc", { body: { method: "vaults", params: {} }, token });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ result: [{ id: "main", type: "obsidian-vault", readOnly: false }] });
    expect(response.headers["cache-control"]).toBe("no-store");
    const malformed = await request(status.port, cert, 'http://[', { body: {} });
    expect(malformed.status).toBe(400);
    const origin = await request(status.port, cert, "/rpc", { body: { method: "vaults", params: {} }, token, agent: false });
    expect(origin.status).toBe(200);
  });

  it("rejects browser origins, URL tokens, traversal, hidden files and symlinks", async () => {
    const ctx = setup();
    const { status, cert } = await start(ctx);
    fs.writeFileSync(path.join(ctx.vault, "ok.md"), "safe");
    fs.mkdirSync(path.join(ctx.vault, "hidden"));
    fs.writeFileSync(path.join(ctx.vault, ".secret.md"), "secret");
    fs.symlinkSync(path.join(ctx.vault, "ok.md"), path.join(ctx.vault, "link.md"));
    const token = await pair(ctx, status.port, cert, ctx.service.createPairing().pairingCode);
    const originReq = await new Promise((resolve, reject) => {
      const req = https.request({ hostname: "localhost", port: status.port, path: "/rpc", method: "POST", ca: cert, headers: { origin: "https://example.test", authorization: `Bearer ${token}`, "content-type": "application/json" } }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode)); });
      req.on("error", reject); req.end(JSON.stringify({ method: "read", params: { vaultId: "main", path: "ok.md" } }));
    });
    expect(originReq).toBe(403);
    const queryResponse = await request(status.port, cert, "/rpc?token=ignored", { body: { method: "read", params: { vaultId: "main", path: "ok.md" } }, token });
    expect(queryResponse.status).toBe(400);
    const emptyQueryResponse = await request(status.port, cert, "/rpc?", { body: { method: "read", params: { vaultId: "main", path: "ok.md" } }, token });
    expect(emptyQueryResponse.status).toBe(400);
    for (const name of ["../outside.md", ".secret.md", "link.md", "sub/../../ok.md"]) {
      const response = await request(status.port, cert, "/rpc", { body: { method: "read", params: { vaultId: "main", path: name } }, token });
      expect(response.status).toBeGreaterThanOrEqual(400);
    }
  });

  it("reads the coalescer buffer for read and search", async () => {
    const ctx = setup();
    const { status, cert } = await start(ctx);
    const token = await pair(ctx, status.port, cert, ctx.service.createPairing().pairingCode);
    const file = path.join(ctx.vault, "fresh.md");
    fs.writeFileSync(file, "old disk text");
    ctx.writeCoalescer.getPending.mockReturnValue({ data: "buffered 最新文本", encoding: "utf8" });
    const readResult = await request(status.port, cert, "/rpc", { body: { method: "read", params: { vaultId: "main", path: "fresh.md" } }, token });
    expect(readResult.body.result.content).toBe("buffered 最新文本");
    const searchResult = await request(status.port, cert, "/rpc", { body: { method: "search", params: { vaultId: "main", query: "最新文本" } }, token });
    expect(searchResult.body.result).toEqual([expect.objectContaining({ path: "fresh.md" })]);
  });

  it("fences writes when pairing is revoked during coalescer flush", async () => {
    const ctx = setup();
    const { status, cert } = await start(ctx);
    const token = await pair(ctx, status.port, cert, ctx.service.createPairing().pairingCode);
    const created = await request(status.port, cert, "/rpc", { body: { method: "create", params: { vaultId: "main", path: "fenced.md", content: "before" } }, token });
    let releaseFlush;
    let reachedFlush;
    const atFlush = new Promise((resolve) => { reachedFlush = resolve; });
    ctx.writeCoalescer.flushPending.mockImplementation(() => new Promise((resolve) => { releaseFlush = resolve; reachedFlush(); }));
    const pendingRequest = request(status.port, cert, "/rpc", { body: { method: "edit", params: { vaultId: "main", path: "fenced.md", content: "after", expectedRevision: created.body.result.revision } }, token }).catch(() => null);
    await atFlush;
    ctx.service.revokeClients();
    await ctx.service.enable({ ips: ["127.0.0.1"] });
    releaseFlush();
    await pendingRequest;
    expect(fs.readFileSync(path.join(ctx.vault, "fenced.md"), "utf8")).toBe("before");
  });

  it("expires pairing codes and enforces conditional create/edit/append writes", async () => {
    const ctx = setup();
    const { status, cert } = await start(ctx);
    const expired = ctx.service.createPairing();
    const realNow = Date.now;
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + 3 * 60 * 1000);
    const rejected = await request(status.port, cert, "/pair", { body: { clientName: "late", pairingCode: expired.pairingCode } });
    expect(rejected.status).toBe(410);
    vi.spyOn(Date, "now").mockRestore();

    const token = await pair(ctx, status.port, cert, ctx.service.createPairing().pairingCode);
    let created = await request(status.port, cert, "/rpc", { body: { method: "create", params: { vaultId: "main", path: "note.md", content: "first" } }, token });
    expect(created.status).toBe(200);
    expect(fs.readFileSync(path.join(ctx.vault, "note.md"), "utf8")).toBe("first");
    const stale = await request(status.port, cert, "/rpc", { body: { method: "edit", params: { vaultId: "main", path: "note.md", content: "lost", expectedRevision: "0".repeat(64) } }, token });
    expect(stale.status).toBe(409);
    created = await request(status.port, cert, "/rpc", { body: { method: "edit", params: { vaultId: "main", path: "note.md", content: "second", expectedRevision: created.body.result.revision } }, token });
    expect(created.status).toBe(200);
    const appended = await request(status.port, cert, "/rpc", { body: { method: "append", params: { vaultId: "main", path: "note.md", content: "!", expectedRevision: created.body.result.revision } }, token });
    expect(appended.status).toBe(200);
    expect(fs.readFileSync(path.join(ctx.vault, "note.md"), "utf8")).toBe("second!");
    expect(ctx.writeCoalescer.flushPending).toHaveBeenCalledTimes(3);
    expect(ctx.cache.applyMutation).toHaveBeenCalledTimes(3);
  });

  it('queries Obsidian tags and properties, patches uniquely, restores backups and enforces read-only', async () => {
    const ctx = setup();
    fs.writeFileSync(path.join(ctx.vault, 'note.md'), '---\ntags: [work/project]\ntitle: Plan\n---\n# Heading\nhello #work [[Other]]');
    const { status, cert } = await start(ctx);
    const token = await pair(ctx, status.port, cert, ctx.service.createPairing().pairingCode);
    const call = (method, params = {}) => request(status.port, cert, '/rpc', { token, body: { method, params: { vaultId: 'main', path: 'note.md', ...params } } });
    const meta = await call('metadata');
    expect(meta.body.result.tags).toContain('work/project');
    expect(meta.body.result.title).toBe('Plan');
    expect((await call('query', { tag: 'work/project' })).body.result.total).toBe(1);
    expect((await call('tags')).body.result.items).toContainEqual({ tag: 'work', count: 1 });
    const changed = await call('patch', { oldText: 'hello', newText: 'world', expectedRevision: meta.body.result.revision });
    expect(changed.status).toBe(200);
    const saved = await call('backups');
    expect(saved.body.result.length).toBe(1);
    const restored = await call('restore', { backupId: saved.body.result[0].backupId, expectedRevision: changed.body.result.revision });
    expect(restored.status).toBe(200);
    expect(fs.readFileSync(path.join(ctx.vault, 'note.md'), 'utf8')).toContain('hello');
    fs.writeFileSync(path.join(ctx.vault, 'large.md'), Buffer.alloc(1024 * 1024 + 1));
    expect((await call('read', { path: 'large.md' })).status).not.toBe(200);
    expect((await call('patch', { oldText: 'hello', newText: 'x', expectedRevision: '0'.repeat(64) })).status).toBe(409);
    ctx.service.setAccess({ vaultIds: ['main'], allowWrite: false });
    expect((await call('edit', { content: 'denied', expectedRevision: restored.body.result.revision })).status).toBe(403);
    ctx.service.setAccess({ vaultIds: [], allowWrite: false });
    expect((await call('read')).status).toBe(403);
  });

  it('preserves original content if atomic replacement fails and keeps backup outside vault', async () => {
    const ctx = setup();
    fs.writeFileSync(path.join(ctx.vault, 'note.md'), 'original');
    const { status, cert } = await start(ctx);
    const token = await pair(ctx, status.port, cert, ctx.service.createPairing().pairingCode);
    const call = (method, params = {}) => request(status.port, cert, '/rpc', { token, body: { method, params: { vaultId: 'main', path: 'note.md', ...params } } });
    const note = await call('read');
    const rename = fs.renameSync;
    const spy = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (to === path.join(ctx.vault, 'note.md')) throw Object.assign(new Error('simulated disk failure'), { code: 'EIO' });
      return rename(from, to);
    });
    expect((await call('edit', { content: 'replacement', expectedRevision: note.body.result.revision })).status).not.toBe(200);
    spy.mockRestore();
    expect(fs.readFileSync(path.join(ctx.vault, 'note.md'), 'utf8')).toBe('original');
    expect(fs.readdirSync(ctx.vault)).toEqual(['note.md']);
    expect((await call('backups')).body.result.length).toBe(1);
  });

  it("drops paired credentials and destroys existing sockets on disable", async () => {
    const ctx = setup();
    const { status, cert } = await start(ctx);
    const token = await pair(ctx, status.port, cert, ctx.service.createPairing().pairingCode);
    const agent = new https.Agent({ keepAlive: true, ca: cert });
    await request(status.port, cert, "/rpc", { body: { method: "vaults", params: {} }, token, agent });
    const revoked = ctx.service.revokeClients();
    expect(revoked.pairedClients).toBe(0);
    const unauthorized = await request(status.port, cert, "/rpc", { body: { method: "vaults", params: {} }, token, agent });
    expect(unauthorized.status).toBe(401);
    const socket = Object.values(agent.freeSockets).flat()[0];
    expect(socket).toBeTruthy();
    const socketClosed = socket.destroyed ? Promise.resolve() : new Promise((resolve) => socket.once("close", resolve));
    await ctx.service.disable();
    await socketClosed;
    expect(socket.destroyed).toBe(true);
    agent.destroy();
    expect(ctx.service.status().running).toBe(false);
    expect(ctx.service.status().pairedClients).toBe(0);
  });

  it("preserves pinned identity and pairing over stop/start and a new service instance", async () => {
    const ctx = setup();
    const { status, cert } = await start(ctx);
    const token = await pair(ctx, status.port, cert, ctx.service.createPairing().pairingCode);
    await ctx.service.disable();
    const restarted = await ctx.service.enable({ ips: ["192.168.2.55"] });
    expect(restarted.fingerprint).toBe(status.fingerprint);
    expect(restarted.deviceId).toBe(status.deviceId);
    expect((await request(restarted.port, cert, "/rpc", { body: { method: "vaults", params: {} }, token })).status).toBe(200);
    await ctx.service.disable();
    const fresh = createAiLanService({ config: {
      dataRoot: path.join(ctx.root, "data"), vaults: { main: ctx.vault },
      getVaultPath: (id) => id === "main" ? ctx.vault : null,
    }, bootstrapCache: ctx.cache, writeCoalescer: ctx.writeCoalescer });
    services.push(fresh);
    const next = await fresh.enable({ ips: ["192.168.3.55"] });
    expect(next.fingerprint).toBe(status.fingerprint);
    expect(next.deviceId).toBe(status.deviceId);
    expect((await request(next.port, cert, "/rpc", { body: { method: "vaults", params: {} }, token })).status).toBe(200);
  });

  it("answers matching UDP discovery nonces without exposing credentials", async () => {
    const ctx = setup();
    const { status } = await start(ctx);
    if (!ctx.service.status().discoveryAvailable) return;
    const client = dgram.createSocket("udp4");
    const response = new Promise((resolve, reject) => {
      client.once("message", (message) => resolve(JSON.parse(message.toString("utf8"))));
      client.once("error", reject);
      client.send(Buffer.from(JSON.stringify({ type: "vitreus-ai-discover", version: 1, nonce: "nonce-123" })), 39871, "127.0.0.1");
    });
    const result = await response;
    client.close();
    expect(result).toEqual({ type: "vitreus-ai-service", version: 1, nonce: "nonce-123", deviceId: status.deviceId, port: status.port });
    expect(result).not.toHaveProperty("fingerprint");
    expect(result).not.toHaveProperty("token");
  });
});
