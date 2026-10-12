import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createRequire } from "module";
import http from "node:http";

// Read at module load; lets the test reach its loopback upstreams.
process.env.PROXY_ALLOW_PRIVATE_HOSTS = "127.0.0.1";

const require = createRequire(import.meta.url);
const { proxyRequest } = require("./relay.js");

let target;
let redirector;

beforeAll(async () => {
  target = http.createServer((req, res) => {
    res.end(
      JSON.stringify({
        authorization: req.headers["authorization"] ?? null,
        cookie: req.headers["cookie"] ?? null,
      }),
    );
  });

  await new Promise((r) => target.listen(0, "127.0.0.1", r));

  // A different port is a different origin.
  redirector = http.createServer((req, res) => {
    res.writeHead(302, {
      Location: `http://127.0.0.1:${target.address().port}/`,
    });
    res.end();
  });

  await new Promise((r) => redirector.listen(0, "127.0.0.1", r));
});

afterAll(() => {
  target.close();
  redirector.close();
});

describe("proxyRequest cross-origin redirect", () => {
  it("keeps Authorization and Cookie, like Electron net.request redirect:follow", async () => {
    const res = await proxyRequest({
      url: `http://127.0.0.1:${redirector.address().port}/`,
      method: "GET",
      headers: { Authorization: "Basic abc", Cookie: "a=1" },
      body: null,
    });

    const chunks = [];

    for await (const c of res) {
      chunks.push(c);
    }

    expect(JSON.parse(Buffer.concat(chunks).toString())).toEqual({
      authorization: "Basic abc",
      cookie: "a=1",
    });
  });
});
