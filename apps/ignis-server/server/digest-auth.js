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

// HTTP 头里的非 ASCII 值（比如中文用户名）在 Node 里是按 latin1 逐字节解出来的，
// 而 HA1 必须用浏览器原本的 UTF-8 文本计算。这里把 latin1 字节还原成 UTF-8。
// 纯 ASCII 输入原样返回，不影响英文账号。
function decodeHeaderText(value) {
  if (!value || !/[\u0080-\u00ff]/.test(value)) {
    return value;
  }
  try {
    const restored = Buffer.from(value, "latin1").toString("utf8");
    // 还原失败会带 U+FFFD；此时保留原值，避免把本来就正确的串弄坏
    return restored.indexOf("\ufffd") >= 0 ? value : restored;
  } catch (e) {
    return value;
  }
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

    const h = req.headers["authorization"];
    const supplied = h && /^Digest\s/i.test(h)
      ? parseDigestParams(h.slice(h.indexOf(" ") + 1)) : null;
    // Keep the presented nonce until its expiry can be reported as stale, not bad credentials.
    for (const [k, v] of issuedNonces) {
      if (now - v.ts > NONCE_TTL && k !== supplied?.nonce) issuedNonces.delete(k);
    }

    if (!h || !/^Digest\s/i.test(h)) {
      res.set("WWW-Authenticate", challenge(false));
      return res.status(401).send("401 Unauthorized");
    }

    const p = parseDigestParams(h.slice(h.indexOf(" ") + 1));
    const rec = issuedNonces.get(p.nonce);
    if (!p.response || !p.username) {
      res.set("WWW-Authenticate", challenge(false));
      return res.status(401).send("401 Unauthorized");
    }
    // 带了 nonce 但服务端已不认识（并发请求里先到的那个把过期 nonce 清掉了，或服务重启）：
    // 必须回 stale=true 让浏览器用已存的凭证静默重试；回 stale=false 会被当作"密码被拒"而弹登录框。
    if (!rec) {
      res.set("WWW-Authenticate", challenge(true));
      return res.status(401).send("401 Stale Nonce");
    }

    const ha1 = md5(creds.user + ":" + REALM + ":" + creds.pass);
    // 浏览器可能用原始 UTF-8 文本算 HA1，也可能用 latin1 字节算；两种都接受。
    const ha1Latin1 = md5(Buffer.from(creds.user, "utf8").toString("latin1") + ":" + REALM + ":" + creds.pass);
    const ha2 = md5(req.method + ":" + p.uri);
    const compute = (base) => {
      if (p.qop === "auth" && p.nc && p.cnonce) {
        return md5(base + ":" + p.nonce + ":" + p.nc + ":" + p.cnonce + ":auth:" + ha2);
      }
      return md5(base + ":" + p.nonce + ":" + ha2);
    };
    const expected = compute(ha1);
    const expectedLatin1 = compute(ha1Latin1);

    const suppliedUser = decodeHeaderText(p.username);
    // 用户名也接受原样与还原两种形态，避免不同客户端/中间层的编码差异
    const userNameOk = suppliedUser === creds.user || p.username === creds.user;
    if (!userNameOk || (expected !== p.response && expectedLatin1 !== p.response)) {
      recordFailure(ip, now);
      res.set("WWW-Authenticate", challenge(false));
      return res.status(401).send("401 Unauthorized");
    }

    if (now - rec.ts > NONCE_TTL) {
      // 不在此处删除：同一过期 nonce 上还有并发在途请求，交给顶部的定期清理
      res.set("WWW-Authenticate", challenge(true));
      return res.status(401).send("401 Stale Nonce");
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
