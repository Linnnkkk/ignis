const express = require("express");
const path = require("path");
const fs = require("fs");
const settings = require("../../settings");
const config = require("../../config");
const { sanitizeError } = require("@ignis/server-core");
const {
  signinCredentials,
  resolveSignin,
} = require("../../obsidian-account/signin");
const { assertPublicUrl } = require("./ssrf-guard");
const { relayOnce } = require("./relay");

const router = express.Router();

// POST /api/proxy - forward a request to an external URL to bypass CORS.
router.post("/", async (req, res) => {
  const { url, method, headers, body, binary } = req.body;

  if (!url) {
    return res.status(400).json({ error: "Missing url" });
  }

  // Obsidian 1.13+ 渲染器会请求 app://obsidian.md/...（Electron 自定义协议，
  // 读 Obsidian 自带资源：语言包/字体/内置图标）。真 Electron 里由主进程 handle；
  // web 里经 shim 走到本代理。这里直接映射到 obsidian-assets/ 本地文件，
  // 不做公网校验（是本地资源不是外网请求）——必须在 assertPublicUrl 之前返回。
  if (url.startsWith("app://obsidian.md/")) {
    const rel = decodeURIComponent(url.slice("app://obsidian.md/".length).split("?")[0]);
    const safe = path.normalize(rel).replace(/^(\.\.[/\\])+/, "");
    const filePath = path.join(config.obsidianAssetsPath, safe);
    // 只允许 obsidian-assets 内（防路径穿越）
    if (!filePath.startsWith(path.resolve(config.obsidianAssetsPath))) {
      return res.status(403).json({ error: "app:// path escapes assets" });
    }
    fs.readFile(filePath, (err, data) => {
      if (err) {
        return res.status(404).json({ error: "app:// resource not found: " + safe });
      }
      res.status(200).send(data);
    });
    return;
  }

  const proxyMode = settings.get("proxyMode");

  if (proxyMode === "disabled") {
    return res.status(403).json({
      error:
        "Ignis blocked the connection: proxy access is disabled (Settings > Ignis > General > Security).",
      code: "disabled",
    });
  }

  try {
    await assertPublicUrl(url);
  } catch (e) {
    // assertPublicUrl throws deliberate, safe guard messages (blocked host, bad scheme); don't use sanitizeError.
    // leak-allow
    const body = { error: e.message, ...e.block };
    return res.status(e.statusCode || 400).json(body);
  }

  if (proxyMode === "allowlist") {
    const allowlist = settings.get("proxyAllowlist");
    const host = new URL(url).hostname;

    if (!allowlist.includes(host)) {
      return res.status(403).json({
        error: `Ignis blocked a connection to ${host}: the host is not in the proxy host allowlist (Settings > Ignis > General > Security).`,
        code: "allowlist",
        host,
      });
    }
  }

  try {
    const reqBody =
      binary && typeof body === "string" ? Buffer.from(body, "base64") : body;

    const relayArgs = {
      url,
      method: method || "GET",
      headers: headers || {},
      body: reqBody,
    };

    const credentials = signinCredentials(req.body);
    let relayed = await relayOnce(relayArgs);

    if (credentials) {
      relayed = await resolveSignin(credentials, relayed, () =>
        relayOnce(relayArgs),
      );
    }

    if (relayed.tooLarge) {
      return res.status(413).json({ error: "Upstream response too large" });
    }

    res.json(relayed);
  } catch (e) {
    if (e.block) {
      // leak-allow
      const body = { error: e.message, ...e.block };
      return res.status(e.statusCode || 403).json(body);
    }

    res.status(e.statusCode || 502).json(sanitizeError(e));
  }
});

module.exports = router;
