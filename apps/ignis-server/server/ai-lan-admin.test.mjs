import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const express = require("express");
const { setupAiLan } = require("./ai-lan-admin");

describe("native AI management boundary", () => {
  it("accepts native loopback actions but rejects browser origins", async () => {
    const calls = [];
    const service = {
      status: () => ({ running: false }),
      enable: async (opts) => { calls.push(opts); return { running: true }; },
      disable: async () => ({ running: false }),
      createPairing: async () => ({ pairingCode: "test-only" }),
      revokeClients: async () => ({ pairedClients: 0 }),
    };
    const app = express();
    app.use(express.json());
    setupAiLan(app, {}, service);
    const server = await new Promise((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    const base = `http://127.0.0.1:${server.address().port}/api/admin/ai-lan`;
    try {
      const denied = await fetch(base, { headers: { Origin: "http://localhost" } });
      expect(denied.status).toBe(403);
      const state = await fetch(base);
      expect(state.headers.get("cache-control")).toBe("no-store");
      expect(await state.json()).toEqual({ running: false });
      const enabled = await fetch(base, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "enable", ips: ["192.168.1.2"] }),
      });
      expect(await enabled.json()).toEqual({ running: true });
      expect(calls).toEqual([{ ips: ["192.168.1.2"], port: undefined }]);
      const invalid = await fetch(base, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "arbitrary" }),
      });
      expect(invalid.status).toBe(400);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
