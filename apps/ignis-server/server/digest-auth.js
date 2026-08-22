// RFC 2617 Digest Auth —— LAN 共享模式专用鉴权（挑战应答，密码永不裸传）
// 凭证来自 env：IGNIS_AUTH_USER / IGNIS_AUTH_PASS（壳层在开启共享时注入）。
// 未设置凭证 = 纯本地模式，中间件完全放行，行为与从前一致；
// 回环请求（壳层 WebView 走 127.0.0.1）同样放行——只有局域网来的请求需要验身。
const crypto = require("crypto");

const REALM = "vitreus-lan";
const NONCE_TTL = 10 * 60 * 1000;
const issuedNonces = new Map(); // nonce -> 签发时间戳

function md5(s) {
  return crypto.createHash("md5").update(s).digest("hex");
}

function isLoopback(ip) {
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

function newNonce() {
  const now = Date.now();
  if (issuedNonces.size > 512) {
    for (const [k, ts] of issuedNonces) {
      if (now - ts > NONCE_TTL) {
        issuedNonces.delete(k);
      }
    }
  }
  const n = crypto.randomBytes(16).toString("hex");
  issuedNonces.set(n, now);
  return n;
}

function challenge() {
  return 'Digest realm="' + REALM + '", qop="auth", nonce="' + newNonce() + '", algorithm=MD5';
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
    const user = process.env.IGNIS_AUTH_USER;
    const pass = process.env.IGNIS_AUTH_PASS;

    // 未配置凭证（纯本地模式）或回环请求：直接放行
    if (!user || !pass || isLoopback(req.ip || "")) {
      return next();
    }

    const now = Date.now();
    for (const [k, ts] of issuedNonces) {
      if (now - ts > NONCE_TTL) {
        issuedNonces.delete(k);
      }
    }

    const h = req.headers["authorization"];
    if (!h || !/^Digest\s/i.test(h)) {
      res.set("WWW-Authenticate", challenge());
      return res.status(401).send("401 Unauthorized");
    }

    const p = parseDigestParams(h.slice(h.indexOf(" ") + 1));
    const ts = issuedNonces.get(p.nonce);
    if (!ts || !p.response || !p.username) {
      res.set("WWW-Authenticate", challenge());
      return res.status(401).send("401 Unauthorized");
    }

    const ha1 = md5(user + ":" + REALM + ":" + pass);
    const ha2 = md5(req.method + ":" + p.uri);
    let expected;
    if (p.qop === "auth" && p.nc && p.cnonce) {
      expected = md5(ha1 + ":" + p.nonce + ":" + p.nc + ":" + p.cnonce + ":auth:" + ha2);
    } else {
      expected = md5(ha1 + ":" + p.nonce + ":" + ha2);
    }

    if (p.username !== user || expected !== p.response) {
      res.set("WWW-Authenticate", challenge());
      return res.status(401).send("401 Unauthorized");
    }

    return next();
  };
}

module.exports = { createDigestAuth };
