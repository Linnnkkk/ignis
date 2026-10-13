import { createRequire } from "node:module";
import crypto from "node:crypto";
import { describe, it, expect, vi, afterEach } from "vitest";

const require = createRequire(import.meta.url);
const { createDigestAuth, setCredentials } = require("./digest-auth.js");

const md5 = (s) => crypto.createHash("md5").update(s).digest("hex");

function call(mw, headers = {}) {
  const res = {
    headers: {},
    set(k, v) { this.headers[k] = v; return this; },
    status(c) { this.code = c; return this; },
    send() { return this; },
  };
  let nexted = false;
  mw({ ip: "192.168.1.5", method: "GET", headers }, res, () => { nexted = true; });
  return { res, nexted };
}

function authHeader(challenge, nc) {
  const nonce = /nonce="([^"]+)"/.exec(challenge)[1];
  const cnonce = "abc";
  const ncs = nc.toString(16).padStart(8, "0");
  const ha1 = md5("u:vitreus-lan:p");
  const ha2 = md5("GET:/x");
  const response = md5(`${ha1}:${nonce}:${ncs}:${cnonce}:auth:${ha2}`);
  return `Digest username="u", realm="vitreus-lan", nonce="${nonce}", uri="/x", qop=auth, nc=${ncs}, cnonce="${cnonce}", response="${response}"`;
}

describe("digest-auth stale nonce", () => {
  afterEach(() => { vi.useRealTimers(); setCredentials(null); });

  it("answers concurrent requests on an expired nonce with stale=true, never a fresh challenge", () => {
    vi.useFakeTimers();
    setCredentials("u", "p");
    const mw = createDigestAuth();

    const first = call(mw);
    const ch = first.res.headers["WWW-Authenticate"];
    expect(call(mw, { authorization: authHeader(ch, 1) }).nexted).toBe(true);

    vi.advanceTimersByTime(100 * 1000);

    const a = call(mw, { authorization: authHeader(ch, 2) });
    const b = call(mw, { authorization: authHeader(ch, 3) });
    expect(a.res.headers["WWW-Authenticate"]).toContain('stale="true"');
    expect(b.res.headers["WWW-Authenticate"]).toContain('stale="true"');

    // Retry with the fresh nonce succeeds.
    const fresh = a.res.headers["WWW-Authenticate"];
    expect(call(mw, { authorization: authHeader(fresh, 1) }).nexted).toBe(true);
  });
});
