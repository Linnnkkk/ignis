import { describe, it, expect, afterAll } from "vitest";
import { createRequire } from "module";
import crypto from "crypto";
import fs from "fs";
import https from "https";
import os from "os";
import path from "path";

const require = createRequire(import.meta.url);
const tlsCert = require("./tls-cert.js");

const roots = [];
const mkRoot = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "ignis-tls-"));
  roots.push(d);
  return d;
};
afterAll(() => roots.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

describe("tls-cert", () => {
  it("generates a parseable, self-verifying cert with the wanted SAN", () => {
    const { cert } = tlsCert.ensure(mkRoot(), ["192.168.1.8", "10.0.0.5"]);
    const x = new crypto.X509Certificate(cert);
    expect(x.verify(x.publicKey)).toBe(true);
    expect(x.ca).toBe(false);
    expect(x.checkIP("192.168.1.8")).toBe("192.168.1.8");
    expect(x.checkIP("10.0.0.5")).toBe("10.0.0.5");
    expect(x.checkHost("localhost")).toBe("localhost");
    expect(x.checkIP("1.2.3.4")).toBeUndefined();
  });

  it("reuses the same cert while the IP is covered (stable fingerprint)", () => {
    const root = mkRoot();
    const a = tlsCert.ensure(root, ["192.168.1.8"]);
    const b = tlsCert.ensure(root, ["192.168.1.8"]);
    expect(b.fingerprint).toBe(a.fingerprint);
  });

  it("re-issues when a new IP appears, keeping old IPs in the SAN", () => {
    const root = mkRoot();
    const a = tlsCert.ensure(root, ["192.168.1.8"]);
    const b = tlsCert.ensure(root, ["172.20.10.2"]);
    expect(b.fingerprint).not.toBe(a.fingerprint);
    expect(b.ips).toEqual(expect.arrayContaining(["172.20.10.2", "192.168.1.8"]));
    // 之后回到旧 IP 不再换证
    expect(tlsCert.ensure(root, ["192.168.1.8"]).fingerprint).toBe(b.fingerprint);
  });

  it("ignores invalid IP input and recovers from a corrupt key", () => {
    const root = mkRoot();
    const a = tlsCert.ensure(root, ["not-an-ip", "999.1.1.1", "192.168.0.9"]);
    expect(a.ips).toContain("192.168.0.9");
    expect(a.ips).not.toContain("999.1.1.1");
    fs.writeFileSync(path.join(root, "lan-tls", "key.pem"), "garbage");
    const b = tlsCert.ensure(root, ["192.168.0.9"]);
    expect(b.fingerprint).not.toBe(a.fingerprint);
  });

  it("works for a real TLS handshake (https + pinned self-signed cert)", async () => {
    const { key, cert } = tlsCert.ensure(mkRoot(), ["127.0.0.1"]);
    const srv = https.createServer({ key, cert }, (req, res) => res.end("ok"));
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    const port = srv.address().port;
    const body = await new Promise((resolve, reject) => {
      https
        .get({ host: "127.0.0.1", port, ca: cert, path: "/" }, (res) => {
          let d = "";
          res.on("data", (c) => (d += c));
          res.on("end", () => resolve(d));
        })
        .on("error", reject);
    });
    srv.close();
    expect(body).toBe("ok");
  });
});
