// RFC 2617 Digest Auth —— LAN 共享模式专用鉴权（挑战应答，密码永不裸传）
// v2（伺服器模式）：凭证动态化（lan-share.js 运行时注入，env 兜底保持兼容）
//   + 失败锁定（5 次锁 60s，指数退避至 15min，按直连 IP 记账）
//   + nonce 严格化（90s 时效 + nc 单调递增防重放 + stale=true 无感换发）
// 未设置凭证 = 纯本地模式，中间件完全放行，行为与从前一致；
// 回环请求（壳层 WebView 走 127.0.0.1）同样放行——只有局域网来的请求需要验身。
const crypto = require("crypto");

const REALM = "vitreus-lan";
const NONCE_TTL = 90 * 1000; // 短时效；过期走 stale 换发，浏览器无感重试
const issuedNonces = new Map(); // nonce -> { ts, lastNc }

// 动态凭证：lan-share.js 运行时 setCredentials；未设置时兜底读 env（旧启动方式兼容）
let runtimeCreds = null;
function setCredentials(user, pass) {
  runtimeCreds = pass ? { user, pass } : null;
}
function getCredentials() {
  if (runtimeCreds) return runtimeCreds;
  const u = process.env.IGNIS_AUTH_USER;
  const p = process.env.IGNIS_AUTH_PASS;
  return u && p ? { user: u, pass: p } : null;
}

// 失败锁定：按直连 IP（socket 层地址，伪造不了 XFF）
const LOCK_BASE_MS = 60 * 1000;
const LOCK_MAX_MS = 15 * 60 * 1000;
const FAIL_LIMIT = 5;
const failTable = new Map(); // ip -> { fails, lockedUntil }

function lockRemaining(ip, now) {
  const rec = failTable.get(ip);
  if (!rec || !rec.lockedUntil || rec.lockedUntil <= now) return 0;
  return rec.lockedUntil - now;
}

function recordFailure(ip, now) {
  let rec = failTable.get(ip) || { fails: 0, lockedUntil: 0 };
  rec.fails += 1;
  if (rec.fails >= FAIL_LIMIT) {
    // 指数退避：第 5 次锁 60s，之后每次翻倍，封顶 15 分钟
    const extra = Math.min(LOCK_BASE_MS * Math.pow(2, rec.fails - FAIL_LIMIT), LOCK_MAX_MS);
    rec.lockedUntil = now + extra;
    rec.fails = 0; // 重新计数（下一轮锁定窗口从 0 开始累积）
  }
  failTable.set(ip, rec);
  // 防表膨胀：超过 1024 条清理已解锁记录
  if (failTable.size > 1024) {
    for (const [k, r] of failTable) {
      if (!r.lockedUntil || r.lockedUntil <= now) failTable.delete(k);
    }
  }
}

function recordSuccess(ip) {
  failTable.delete(ip);
}

function md5(s) {
  return crypto.createHash("md5").update(s).digest("hex");
}

function isLoopback(ip) {
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

function newNonce() {
  const now = Date.now();
  if (issuedNonces.size > 512) {
    for (const [k, v] of issuedNonces) {
      if (now - v.ts > NONCE_TTL) issuedNonces.delete(k);
    }
  }
  const n = crypto.randomBytes(16).toString("hex");
  issuedNonces.set(n, { ts: now, lastNc: 0 });
  return n;
}

function challenge(stale) {
  return (
    'Digest realm="' + REALM + '", qop="auth", nonce="' + newNonce() +
    '", algorithm=MD5' + (stale ? ', stale="true"' : "")
  );
}

// Authorization: Digest k="v", k2="v2" -> { k: v, k2: v2 }
function parseDigestParams(rest) {
  const out = {};
  const re = /(\w+)=(?:"([^"]*)"|([^\s,]+))/g;
  let m;
  while ((m = re.exec(rest)) !== null) {
    out[m[1].toLowerCase()] = m[2] !== undefined ? m[2] : m[3];
  }
  return out;
}

function createDigestAuth() {
  return function digestAuth(req, res, next) {
    const creds = getCredentials();
    const ip = req.ip || "";

    // 未配置凭证（纯本地模式）或回环请求：直接放行
    if (!creds || isLoopback(ip)) {
      return next();
    }

    const now = Date.now();
    const lockMs = lockRemaining(ip, now);
    if (lockMs > 0) {
      res.set("Retry-After", Math.ceil(lockMs / 1000));
      return res.status(429).send("429 Too Many Attempts");
    }

    for (const [k, v] of issuedNonces) {
      if (now - v.ts > NONCE_TTL) issuedNonces.delete(k);
    }

    const h = req.headers["authorization"];
    if (!h || !/^Digest\s/i.test(h)) {
      res.set("WWW-Authenticate", challenge(false));
      return res.status(401).send("401 Unauthorized");
    }

    const p = parseDigestParams(h.slice(h.indexOf(" ") + 1));
    const rec = issuedNonces.get(p.nonce);
    if (!rec || !p.response || !p.username) {
      res.set("WWW-Authenticate", challenge(false));
      return res.status(401).send("401 Unauthorized");
    }

    const ha1 = md5(creds.user + ":" + REALM + ":" + creds.pass);
    const ha2 = md5(req.method + ":" + p.uri);
    let expected;
    if (p.qop === "auth" && p.nc && p.cnonce) {
      expected = md5(ha1 + ":" + p.nonce + ":" + p.nc + ":" + p.cnonce + ":auth:" + ha2);
    } else {
      expected = md5(ha1 + ":" + p.nonce + ":" + ha2);
    }

    if (p.username !== creds.user || expected !== p.response) {
      recordFailure(ip, now);
      res.set("WWW-Authenticate", challenge(false));
      return res.status(401).send("401 Unauthorized");
    }

    // nc 单调递增：同 nonce 的重复序号 = 重放，拒绝但带 stale 换发（正常浏览器不会撞）
    const ncNum = parseInt(p.nc || "0", 16);
    if (p.qop === "auth") {
      if (!Number.isFinite(ncNum) || ncNum <= rec.lastNc) {
        res.set("WWW-Authenticate", challenge(true));
        return res.status(401).send("401 Stale Nonce");
      }
      rec.lastNc = ncNum;
    }

    recordSuccess(ip);
    return next();
  };
}

module.exports = { createDigestAuth, setCredentials, getCredentials };
