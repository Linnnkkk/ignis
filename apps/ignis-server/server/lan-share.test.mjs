import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createRequire } from "module";
import fs from "fs";
import http from "http";
import https from "https";
import os from "os";
import path from "path";

const require = createRequire(import.meta.url);
const DATA_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ignis-lanshare-"));
process.env.DATA_ROOT = DATA_ROOT;
const express = require("express");
const { WebSocketServer, WebSocket } = require("ws");
const { setupLanShare } = require("./lan-share.js");

let main;
let mainPort;
let wss;

function api(method, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        host: "127.0.0.1", port: mainPort, path: "/api/admin/lan-share", method,
        headers: data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {},
      },
      (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => resolve({ code: res.statusCode, json: JSON.parse(d) }));
      },
    );
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.get("/ping", (req, res) => res.send("pong"));
  wss = new WebSocketServer({ noServer: true });
  wss.on("connection", (ws) => ws.send("hello"));
  setupLanShare(app, wss);
  main = http.createServer(app);
  await new Promise((r) => main.listen(0, "127.0.0.1", r));
  mainPort = main.address().port;
});

afterAll(async () => {
  await api("POST", { action: "disable" });
  main.close();
  fs.rmSync(DATA_ROOT, { recursive: true, force: true });
});

describe("lan-share TLS", () => {
  it("serves https + wss with a stable pinned self-signed cert, then switches back to http", async () => {
    const on = await api("POST", { action: "enable", user: "u", pass: "pass1", tls: true, ips: ["127.0.0.1"] });
    expect(on.code).toBe(200);
    expect(on.json.running).toBe(true);
    expect(on.json.tls).toBe(true);
    expect(on.json.fingerprint).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
    const ca = fs.readFileSync(path.join(DATA_ROOT, "lan-tls", "cert.pem"), "utf8");
    const port = on.json.port;

    // https（只信任这张自签证书）
    const body = await new Promise((resolve, reject) => {
      https.get({ host: "127.0.0.1", port, ca, path: "/ping" }, (res) => {
        let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => resolve(d));
      }).on("error", reject);
    });
    expect(body).toBe("pong");

    // 未带 ca 的客户端必须被拒（证明确实走了 TLS 且不是裸通道）
    await expect(new Promise((resolve, reject) => {
      https.get({ host: "127.0.0.1", port, path: "/ping" }, resolve).on("error", reject);
    })).rejects.toThrow();

    // 明文 http 打 TLS 端口拿不到内容
    const plain = await new Promise((resolve) => {
      const r = http.get({ host: "127.0.0.1", port, path: "/ping" }, (res) => { res.resume(); resolve("got"); });
      r.on("error", () => resolve("err"));
      r.setTimeout(1500, () => { r.destroy(); resolve("timeout"); });
    });
    expect(plain).not.toBe("got");

    // wss 转发到主 wss
    const msg = await new Promise((resolve, reject) => {
      const ws = new WebSocket(`wss://127.0.0.1:${port}/ws`, { ca });
      ws.on("message", (m) => { resolve(String(m)); ws.close(); });
      ws.on("error", reject);
    });
    expect(msg).toBe("hello");

    // 幂等：相同参数再开一次，指纹与端口不变
    const again = await api("POST", { action: "enable", user: "u", pass: "pass1", tls: true, ips: ["127.0.0.1"], port });
    expect(again.json.fingerprint).toBe(on.json.fingerprint);
    expect(again.json.port).toBe(port);

    // 切回明文：重启后 tls=false，http 可达
    const off = await api("POST", { action: "enable", user: "u", pass: "pass1", tls: false, port });
    expect(off.json.tls).toBe(false);
    expect(off.json.fingerprint).toBe("");
    const plainBody = await new Promise((resolve, reject) => {
      http.get({ host: "127.0.0.1", port: off.json.port, path: "/ping" }, (res) => {
        let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => resolve(d));
      }).on("error", reject);
    });
    expect(plainBody).toBe("pong");
  });
});
