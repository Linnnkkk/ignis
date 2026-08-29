// lan-share.js —— 伺服器模式运行时管理（VIP 局域网共享核心）
// 双 server 无感架构：主 server（127.0.0.1:6791，本地 WebView 专用）不动，
// 开启时动态再 listen 一个 0.0.0.0:随机端口 的 serverB —— 同一 express app 路由零复制，
// digest-auth 中间件按"回环放行 / 外部挑战"自动覆盖 serverB 流量。
// WebSocket：serverB 的 upgrade 手动转发给主 wss.handleUpgrade —— 所有客户端同池，
// 文件变更广播（broadcastToVault）互通，家人设备实时同步不掉线。
// 管理 API 仅回环可达（外部摸不到），供 ArkTS 壳层调用。
const url = require("url");
const digestAuth = require("./digest-auth");

const state = {
  server: null, // http.Server | null
  port: 0,
  since: 0,
};

function status() {
  return {
    running: !!state.server,
    port: state.port,
    since: state.since,
    user: digestAuth.getCredentials()?.user || "",
  };
}

function pickPort() {
  // 随机端口段 30000-60000（避开常用服务段，一键复制含端口所以用户无感）
  return 30000 + Math.floor(Math.random() * 30000);
}

function listenOn(app, port, wss) {
  return new Promise((resolve, reject) => {
    const tryPort = (p, attemptsLeft) => {
      const srv = app.listen(p, "0.0.0.0");
      srv.once("listening", () => resolve(srv));
      srv.once("error", (err) => {
        if (err.code === "EADDRINUSE" && attemptsLeft > 0) {
          tryPort(pickPort(), attemptsLeft - 1);
        } else {
          reject(err);
        }
      });
    };
    tryPort(port, 5);
  });
}

async function enable(app, wss, user, pass, portHint) {
  // 幂等：已开且凭证没变 → 直接返回现状
  if (state.server && digestAuth.getCredentials()?.user === user &&
      digestAuth.getCredentials()?.pass === pass) {
    return status();
  }
  // 凭证变更 → 换血重启（关旧再开新）
  if (state.server) {
    await disable();
  }
  digestAuth.setCredentials(user, pass);

  const wantPort = Number(portHint) > 0 ? Number(portHint) : pickPort();
  const srv = await listenOn(app, wantPort, wss);

  // WS 同池转发：serverB 的 upgrade → 主 wss 处理
  // （wss 以 { server } 模式创建，但 handleUpgrade 始终可手动调；
  //  origin/vault 检查在 connection 层，转发不绕过任何检查）
  srv.on("upgrade", (req, socket, head) => {
    const pathname = url.parse(req.url).pathname;
    if (pathname !== "/ws") {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  state.server = srv;
  state.port = srv.address().port;
  state.since = Date.now();
  console.log(`[lan-share] serverB listening on 0.0.0.0:${state.port} (digest auth on)`);
  return status();
}

function disable() {
  return new Promise((resolve) => {
    if (!state.server) {
      return resolve(status());
    }
    const srv = state.server;
    state.server = null;
    state.port = 0;
    state.since = 0;
    digestAuth.setCredentials(null, null);
    // closeAllConnections：Node 18.2+，同时掐断活跃连接（关闭语义 = 家人设备立刻断开）
    if (typeof srv.closeAllConnections === "function") {
      srv.closeAllConnections();
    }
    srv.close(() => resolve(status()));
    // 兜底：极端情况下 close 回调不来（长连接挂住）
    setTimeout(() => resolve(status()), 2000);
  });
}

function loopbackOnly(req, res, next) {
  const ip = req.ip || "";
  if (ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1") {
    return next();
  }
  return res.status(403).send("403 loopback only");
}

function setupLanShare(app, wss) {
  app.get("/api/admin/lan-share", loopbackOnly, (req, res) => {
    res.json(status());
  });

  app.post("/api/admin/lan-share", loopbackOnly, (req, res) => {
    const body = req.body || {};
    const action = body.action;

    if (action === "enable") {
      const { user, pass, port } = body;
      if (!user || !pass || String(pass).length < 4) {
        return res.status(400).json({ error: "user and pass (>=4 chars) required" });
      }
      enable(app, wss, String(user), String(pass), Number(port) || 0)
        .then((st) => res.json(st))
        .catch((e) => res.status(500).json({ error: String(e && e.message || e) }));
      return;
    }

    if (action === "disable") {
      disable().then((st) => res.json(st));
      return;
    }

    res.status(400).json({ error: "bad action" });
  });
}

module.exports = { setupLanShare };
