// tls-cert.js —— 伺服器模式的自签证书（单向 TLS，防局域网嗅探）
// 不引入第三方依赖：用 Node 自带 crypto 生成 ECDSA P-256 密钥，手写最小 DER 拼出
// X.509 v3 自签证书（SAN 含 localhost + 局域网 IP）。ECDSA 在 jitless 的手机端也是
// 毫秒级（RSA 2048 生成会慢得多）。
// 持久化：<dataRoot>/lan-tls/{key.pem,cert.pem}。指纹稳定是体验关键——浏览器对同一张
// 证书只需放行一次，所以只有「SAN 没覆盖当前 IP」或「剩余有效期 < 30 天」才换新证书；
// 换新时旧 IP 并入新 SAN（最多保留 8 个），手机在 Wi-Fi / 热点间切换也不频繁换证。
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const VALID_DAYS = 825; // Apple 对服务器证书的有效期上限
const RENEW_BEFORE_MS = 30 * 24 * 3600 * 1000;
const MAX_IPS = 8;

// ── DER 基础件 ──────────────────────────────────────────────
function len(n) {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
function tlv(tag, ...parts) {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), len(body.length), body]);
}
const seq = (...p) => tlv(0x30, ...p);
const set = (...p) => tlv(0x31, ...p);
const oid = (dotted) => {
  const a = dotted.split(".").map(Number);
  const out = [a[0] * 40 + a[1]];
  for (const v of a.slice(2)) {
    const chunk = [v & 0x7f];
    for (let x = v >>> 7; x > 0; x >>>= 7) chunk.unshift((x & 0x7f) | 0x80);
    out.push(...chunk);
  }
  return tlv(0x06, Buffer.from(out));
};
const utf8 = (s) => tlv(0x0c, Buffer.from(s, "utf8"));
const octets = (b) => tlv(0x04, b);
const bitString = (b) => tlv(0x03, Buffer.from([0]), b);
const integer = (buf) => {
  // 正整数：去前导 0，最高位为 1 时补 0x00
  let b = buf;
  while (b.length > 1 && b[0] === 0 && !(b[1] & 0x80)) b = b.subarray(1);
  if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]);
  return tlv(0x02, b);
};
function utcTime(d) {
  const p = (n) => String(n).padStart(2, "0");
  const s =
    p(d.getUTCFullYear() % 100) + p(d.getUTCMonth() + 1) + p(d.getUTCDate()) +
    p(d.getUTCHours()) + p(d.getUTCMinutes()) + p(d.getUTCSeconds()) + "Z";
  return tlv(0x17, Buffer.from(s, "ascii"));
}
function ipv4Bytes(ip) {
  return Buffer.from(ip.split(".").map(Number));
}

const IPV4_RE = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
function isIPv4(s) {
  return typeof s === "string" && IPV4_RE.test(s);
}

// ── 证书生成 ────────────────────────────────────────────────
function buildCertificate(privateKey, publicKey, ips, now = new Date()) {
  const algId = seq(oid("1.2.840.10045.4.3.2")); // ecdsa-with-SHA256
  const name = seq(set(seq(oid("2.5.4.3"), utf8("Vitreus LAN Server"))));
  const notBefore = new Date(now.getTime() - 24 * 3600 * 1000); // 容忍设备间时钟偏差
  const notAfter = new Date(now.getTime() + VALID_DAYS * 24 * 3600 * 1000);

  const san = seq(
    tlv(0x82, Buffer.from("localhost", "ascii")), // dNSName
    ...ips.map((ip) => tlv(0x87, ipv4Bytes(ip))), // iPAddress
  );
  const ext = (id, critical, value) =>
    seq(oid(id), ...(critical ? [tlv(0x01, Buffer.from([0xff]))] : []), octets(value));
  const extensions = tlv(
    0xa3,
    seq(
      ext("2.5.29.19", true, seq()), // basicConstraints: CA=false
      ext("2.5.29.15", true, tlv(0x03, Buffer.from([0x07, 0x80]))), // keyUsage: digitalSignature
      ext("2.5.29.37", false, seq(oid("1.3.6.1.5.5.7.3.1"))), // extKeyUsage: serverAuth
      ext("2.5.29.17", false, san),
    ),
  );

  const serial = crypto.randomBytes(16);
  serial[0] &= 0x7f;

  const tbs = seq(
    tlv(0xa0, tlv(0x02, Buffer.from([2]))), // version v3
    integer(serial),
    algId,
    name,
    seq(utcTime(notBefore), utcTime(notAfter)),
    name,
    publicKey.export({ type: "spki", format: "der" }),
    extensions,
  );
  const sig = crypto.sign("sha256", tbs, privateKey); // ECDSA，默认 DER 编码
  return seq(tbs, algId, bitString(sig));
}

function toPem(der, label) {
  const b64 = der.toString("base64").match(/.{1,64}/g).join("\n");
  return `-----BEGIN ${label}-----\n${b64}\n-----END ${label}-----\n`;
}

function generate(ips) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const der = buildCertificate(privateKey, publicKey, ips);
  return {
    key: privateKey.export({ type: "pkcs8", format: "pem" }),
    cert: toPem(der, "CERTIFICATE"),
  };
}

// ── 对外：读取或按需（重新）生成 ─────────────────────────────
function localIps() {
  try {
    const out = [];
    for (const list of Object.values(require("os").networkInterfaces() || {})) {
      for (const i of list || []) {
        if (i.family === "IPv4" && !i.internal && isIPv4(i.address)) out.push(i.address);
      }
    }
    return out;
  } catch (e) {
    return []; // 部分嵌入式 Node 没有该 API，由壳层通过 ips 参数传入
  }
}

function sanIps(certPem) {
  try {
    const x = new crypto.X509Certificate(certPem);
    return (x.subjectAltName || "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.startsWith("IP Address:"))
      .map((s) => s.slice("IP Address:".length));
  } catch (e) {
    return [];
  }
}

function describe(certPem) {
  const x = new crypto.X509Certificate(certPem);
  return {
    fingerprint: x.fingerprint256, // AA:BB:...
    validTo: new Date(x.validTo).getTime(),
    ips: sanIps(certPem),
  };
}

/**
 * 取得可用的 { key, cert, fingerprint, ... }。
 * @param {string} dataRoot 持久化根目录
 * @param {string[]} wantedIps 当前需要覆盖的局域网 IP（壳层传入，合并 os 枚举结果）
 */
function ensure(dataRoot, wantedIps = []) {
  const dir = path.join(dataRoot, "lan-tls");
  const keyFile = path.join(dir, "key.pem");
  const certFile = path.join(dir, "cert.pem");
  const want = [...new Set([...wantedIps, ...localIps()].filter(isIPv4))];

  let key = null;
  let cert = null;
  try {
    key = fs.readFileSync(keyFile, "utf8");
    cert = fs.readFileSync(certFile, "utf8");
  } catch (e) {
    key = cert = null;
  }

  let info = null;
  let existingIps = [];
  if (cert && key) {
    try {
      info = describe(cert);
      existingIps = info.ips;
      crypto.createPrivateKey(key); // 损坏的私钥直接判废
    } catch (e) {
      info = null;
    }
  }

  const covered = want.every((ip) => existingIps.includes(ip));
  if (!info || !covered || info.validTo - Date.now() < RENEW_BEFORE_MS) {
    // 新 IP 在前、旧 IP 垫后，整体封顶
    const merged = [...new Set([...want, ...existingIps])].slice(0, MAX_IPS);
    const fresh = generate(merged);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(keyFile, fresh.key, { mode: 0o600 });
    fs.writeFileSync(certFile, fresh.cert);
    key = fresh.key;
    cert = fresh.cert;
    info = describe(cert);
    console.log(`[lan-tls] generated self-signed cert, SAN ips=${info.ips.join(",") || "-"}`);
  }
  return { key, cert, fingerprint: info.fingerprint, validTo: info.validTo, ips: info.ips };
}

module.exports = { ensure, generate, buildCertificate, isIPv4, describe };
