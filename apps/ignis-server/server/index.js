const express = require("express");
const path = require("path");
const compression = require("compression");
const config = require("./config");
const settings = require("./settings");
const { cacheControlFor } = require("./static/cache-headers");
const { buildIndexHtml } = require("./static/index-html");
const {
  setupWebSocket,
  watcher,
  writeCoalescer,
  resolveVaultPath,
} = require("@ignis/server-core");
const {
  BRIDGE_PLUGIN_ID,
  migratePluginsFromAllVaults,
} = require("./plugin-system/migrate-bridge");
const {
  initPlugins,
  shutdownPlugins,
  getBundledPluginDirs,
  getPluginDataDir,
} = require("./plugin-system/manager");
const obCli = require("./obsidian-account/ob-cli");
const pluginRoutes = require("./routes/plugins");
const { setupDemo, wireDemoWebSocket } = require("./demo");
const { flushAll } = writeCoalescer;

writeCoalescer.configure({ writeCoalesceMs: settings.get("writeCoalesceMs") });
watcher.configure({ ignoredPaths: settings.resolveIgnoreLines() });
obCli.init({
  obHome: path.join(
    getPluginDataDir(config.dataRoot, "headless-sync"),
    "ob-home",
  ),
});

const REPO_ROOT = path.join(__dirname, "..", "..", "..");

const ANSI_RED = "\x1b[31m";
const ANSI_YELLOW = "\x1b[33m";
const ANSI_GREEN = "\x1b[32m";
const ANSI_RESET = "\x1b[0m";

const app = express();

// Reject oversized requests by Content-Length before parsing.
app.use((req, res, next) => {
  const declared = Number(req.headers["content-length"]);

  if (Number.isFinite(declared) && declared > settings.get("maxBodyBytes")) {
    return res.status(413).json({ error: "Request body too large" });
  }

  next();
});

app.use(express.json({ limit: settings.MAX_BODY_BACKSTOP }));
app.use(compression());

// LAN 共享鉴权：设置了 IGNIS_AUTH_USER/PASS 且请求来自局域网时要求 Digest 认证（digest-auth.js）
app.use(require("./digest-auth").createDigestAuth());

// logger middleware
app.use((req, res, next) => {
  const start = Date.now();
  const origEnd = res.end;

  res.end = function (...args) {
    const duration = Date.now() - start;
    const status = res.statusCode;

    const color =
      status >= 500 ? ANSI_RED : status >= 400 ? ANSI_YELLOW : ANSI_GREEN;

    const path =
      req.originalUrl.length > 80
        ? req.originalUrl.slice(0, 80) + "..."
        : req.originalUrl;

    console.log(
      `${color}${req.method} ${status}${ANSI_RESET} ${path} (${duration}ms)`,
    );

    origEnd.apply(this, args);
  };

  next();
});

const fsRoutes = require("./routes/fs");
const vaultRoutes = require("./routes/vault");
const proxyRoutes = require("./routes/proxy");
const versionRoutes = require("./routes/version");
const settingsRoutes = require("./routes/settings");
const bootstrapRoutes = require("./routes/bootstrap");
const bootstrapCache = require("./cache");
const treeReconcile = require("./cache/reconcile");
const { createMetadataChannel } = require("./cache/metadata-channel");
const { registerCacheListeners } = require("./cache/listeners");
const vaultLifecycle = require("./vault/lifecycle");

app.use("/assets", express.static(path.join(__dirname, "assets")));

// Demo mode: layers session/quota/allowlist middleware on top of the existing routes.
// Must run BEFORE the routes are mounted. No-op when DEMO_MODE != true.
setupDemo(app);

app.use("/api/fs", fsRoutes);
app.use("/api/vault", vaultRoutes);
app.use("/api/proxy", proxyRoutes);
app.use("/api/version", versionRoutes);
app.use("/api/settings", settingsRoutes);
app.use("/api/plugins", pluginRoutes);
app.use("/api/bootstrap", bootstrapRoutes);

// ★ Vitreus: 上游 0.8.11 移除了顶层 fs require（buildIndexHtml 搬走后不再需要），
//   但下方 asar 解包器与 i18n 兜底路由依赖 fs，在此补回。
const fs = require("fs");

// ★ Vitreus 构建标记：排障用（前端探针读它确认沙箱里跑的是哪个 bundle——
//   曾经"修复推了但手机跑旧 server"排查一整天，加这个一眼分辨）
app.get("/__vitreus", (req, res) => {
  res.json({ bundle: "v8-asarfull", nodeAsar: true, i18nFallback: true });
});

// ★ Vitreus：Node 侧 asar/asar.gz 解包（对齐官方 Docker entrypoint 的用户自备流程：
//   用户从 obsidianmd/obsidian-releases 下载 obsidian-<ver>.asar.gz 或 obsidian.asar，
//   app 只收这两种格式，不分发任何 Obsidian 内容——合规红线）。
//   ArkTS 解包器跳过 unpacked 文件导致 i18n 缺失（1.13+ 的 i18n 是 unpacked），
//   这里 Node 解包 + unpacked 清单 + 版本警告（官方也 pin 1.12.7，新版本 shim 可能 misbehave）。
  const zlib = require("zlib");
(function unpackAsarIfPresent() {
  // 支持两种自备格式：obsidian.asar.gz（官方 releases 默认）/ obsidian.asar
  const gzPath = path.join(config.obsidianAssetsPath, "obsidian.asar.gz");
  const asarPath = path.join(config.obsidianAssetsPath, "obsidian.asar");
  let workPath = null;
  let asarBuf = null;
  try {
    if (fs.existsSync(gzPath)) {
      console.log("[vitreus-asar] found obsidian.asar.gz, gunzip...");
      asarBuf = zlib.gunzipSync(fs.readFileSync(gzPath));
      workPath = gzPath;
    } else if (fs.existsSync(asarPath)) {
      asarBuf = fs.readFileSync(asarPath);
      workPath = asarPath;
    } else {
      console.log("[vitreus-asar] no obsidian.asar/.asar.gz found, skip");
      return;
    }

    const head = asarBuf.subarray(0, 16);
    const jsonLen = head.readUInt32LE(12);
    const header = JSON.parse(asarBuf.subarray(16, 16 + jsonLen).toString("utf8"));
    let base = 16 + jsonLen;
    base = (base + 3) & ~3; // 4字节对齐

    // 版本警告（对齐官方：版本 ≠ 1.12.7 时提示 shim 兼容风险）
    try {
      const pkg = header.files && header.files["package.json"];
      if (pkg) {
        const pkgTxt = asarBuf.subarray(base + Number(pkg.offset), base + Number(pkg.offset) + pkg.size).toString("utf8");
        const ver = JSON.parse(pkgTxt).version;
        if (ver && ver !== "1.12.7") {
          console.warn(`[vitreus-asar] WARNING: Obsidian ${ver} — shim 兼容性最佳版本是 1.12.7（官方 Docker 同款 pin），新版可能异常`);
        }
      }
    } catch (e) { /* 版本读取失败不阻断 */ }

    let fileCount = 0;
    let unpackedCount = 0;
    const unpackedList = [];
    function walk(node, prefix) {
      if (!node.files) return;
      for (const [name, meta] of Object.entries(node.files)) {
        const rel = prefix ? prefix + "/" + name : name;
        if (meta.files) {
          walk(meta, rel);
        } else {
          if (meta.unpacked) {
            unpackedCount++;
            if (unpackedList.length < 30) unpackedList.push(rel);
            continue;
          }
          const target = path.join(config.obsidianAssetsPath, rel);
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, asarBuf.subarray(base + Number(meta.offset), base + Number(meta.offset) + meta.size));
          fileCount++;
        }
      }
    }
    walk(header, "");
    console.log(`[vitreus-asar] extracted ${fileCount} files, ${unpackedCount} unpacked (no data in asar):`);
    if (unpackedList.length > 0) {
      console.log("[vitreus-asar] unpacked sample:", unpackedList.join(", "));
    }
    // 成功解包后删除原始包（释放 ~9MB；升级时用户重新导入即可）
    try { fs.unlinkSync(workPath); } catch (e) { /* 删不掉无碍 */ }
  } catch (e) {
    console.error("[vitreus-asar] extract failed:", e.message);
  }
})();

// ★ i18n 兜底：obsidian.asar 的 i18n/ 目录常是 unpacked 类型（asar 体内无数据，
// 解包器跳过）→ 手机上缺 i18n 文件 → 404 → ArkWeb fetch 抛 NetworkError →
// Obsidian 启动链断（空白页真凶）。真实文件优先（static 在后面接不住才到这——
// 所以这里先自查磁盘），没有才返回空但合法的内容让 i18n loader fallback。
app.get("/i18n/:file", (req, res) => {
  const file = path.basename(req.params.file || "");
  const realPath = path.join(config.obsidianAssetsPath, "i18n", file);
  if (fs.existsSync(realPath)) {
    res.type("text/plain").sendFile(realPath);
    return;
  }
  console.log("[vitreus] i18n fallback (not in assets):", file);
  res.type("text/plain").status(200).send("");
});

// Serve vault files for resource URLs (images, attachments, etc.)
// Vault ID is the first path segment: /vault-files/<vault-id>/path/to/file
app.use("/vault-files", (req, res, next) => {
  // Extract vault ID from the first path segment
  const parts = req.path.split("/").filter(Boolean);

  if (parts.length === 0) {
    return res.status(400).json({ error: "Missing vault ID" });
  }

  const vaultId = decodeURIComponent(parts[0]);
  const vaultPath = config.getVaultPath(vaultId);

  if (!vaultPath) {
    return res.status(404).json({ error: "Vault not found" });
  }

  let resolved = null;

  try {
    const relPath = parts.slice(1).map(decodeURIComponent).join("/");
    resolved = relPath ? resolveVaultPath(vaultPath, relPath) : null;
  } catch {
    // resolved stays null and gets handled by static handler
  }

  const buffered = resolved ? writeCoalescer.getPending(resolved) : null;

  // Serve buffered content if exists.
  if (buffered) {
    const body = writeCoalescer.pendingBuffer(buffered.data, buffered.encoding);

    const ext = path.extname(resolved);

    if (ext) {
      res.type(ext);
    }

    return res.send(body);
  }

  // Rewrite req.url to strip the vault ID prefix, then serve statically
  req.url = "/" + parts.slice(1).join("/");
  express.static(vaultPath)(req, res, next);
});

app.get(["/", "/index.html"], (req, res) => {
  res.set("Content-Type", "text/html; charset=utf-8");
  res.set("Cache-Control", "no-cache");
  res.send(buildIndexHtml());
});

app.get("/favicon.png", (req, res) => {
  res.sendFile(path.join(REPO_ROOT, "images", "favicon.png"));
});

// Cache headers for static assets, by version query.
// Set before express.static, which only fills Cache-Control when it is not already present.
app.use((req, res, next) => {
  const cacheControl = cacheControlFor(req.path, !!req.query.v);

  if (cacheControl) {
    res.setHeader("Cache-Control", cacheControl);
  }

  next();
});

app.use(express.static(path.join(REPO_ROOT, "packages", "ui", "dist")));
app.use(express.static(path.join(REPO_ROOT, "packages", "shim", "dist")));

app.use(express.static(config.obsidianAssetsPath));

const server = app.listen(config.port, config.host, async () => {
  console.log(`[ignis] Server running on http://${config.host}:${config.port}`);
  console.log(`[ignis] Vault root: ${config.vaultRoot}`);
  console.log(`[ignis] Vaults: ${Object.keys(config.vaults).join(", ")}`);

  await initPlugins({ app, config, wss, watcher });

  const bundledPluginDirs = getBundledPluginDirs();

  for (const { distDir } of bundledPluginDirs) {
    app.use(express.static(distDir));
  }

  await migratePluginsFromAllVaults(config.vaultRoot, [
    BRIDGE_PLUGIN_ID,
    ...bundledPluginDirs.map((d) => d.bundledPluginId),
  ]);

  bootstrapCache
    .warmUp()
    .catch((e) => console.warn("[bootstrap] warm-up error:", e.message));
});

const wss = setupWebSocket(server, {
  getVaultPath: config.getVaultPath,
  originAllowlist: settings.get("wsOrigins"),
});
vaultLifecycle.setWss(wss);

// 伺服器模式：动态 serverB（0.0.0.0 + Digest）管理 API（仅回环，ArkTS 壳层调用）
require("./lan-share").setupLanShare(app, wss);
wireDemoWebSocket(server);

const metadataChannel = createMetadataChannel(wss);

registerCacheListeners({
  bootstrapCache,
  metadataChannel,
  watcher,
  writeCoalescer,
});

watcher.onWatcherStart((vaultId) => {
  bootstrapCache.markForRevalidation(vaultId);
  treeReconcile.startSchedule(vaultId);
});

bootstrapCache.onStaleEntryServed((vaultId) =>
  treeReconcile.scheduleReconcile(vaultId),
);

// Per-client listeners die along with their watcher.
watcher.onWatcherRebuild((vaultId) => {
  // force revalidation to ensure any missed changes are picked up
  bootstrapCache.invalidateVault(vaultId);
  wss.closeVaultSockets(vaultId);
});

writeCoalescer.onFlushGiveUp((absPath) => {
  const match = config.vaultForPath(absPath);

  if (!match) {
    return;
  }

  wss.broadcastToVault(match.vaultId, {
    type: "write-giveup",
    path: match.relPath,
  });
});

async function gracefulShutdown(signal) {
  console.log(`\n[ignis] Received ${signal}, shutting down gracefully...`);

  await flushAll();
  await shutdownPlugins();

  server.close(() => {
    console.log("[ignis] Server closed");
    process.exit(0);
  });

  setTimeout(() => {
    console.error("[ignis] Forced shutdown after timeout");
    process.exit(1);
  }, 10000);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
