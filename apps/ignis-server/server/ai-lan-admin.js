// Native-shell management only. The AI listener is separate from the web app.
const { createAiLanService } = require("./ai-lan");

function setupAiLan(app, config, serviceOverride) {
  const service = serviceOverride || createAiLanService({ config });
  function localOnly(req, res, next) {
    const ip = req.socket.remoteAddress;
    if (req.headers.origin || !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(ip)) {
      return res.status(403).json({ error: "Native local management only" });
    }
    res.setHeader("Cache-Control", "no-store");
    next();
  }
  app.get("/api/admin/ai-lan", localOnly, (_req, res) => res.json(service.status()));
  app.post("/api/admin/ai-lan", localOnly, async (req, res) => {
    try {
      const body = req.body || {};
      let result;
      switch (body.action) {
        case "enable":
          result = await service.enable({ ips: body.ips, port: body.port });
          break;
        case "disable":
          result = await service.disable();
          break;
        case "pair":
          result = { ...service.status(), ...await service.createPairing() };
          break;
        case "access":
          result = service.setAccess(body.access);
          break;
        case "revoke":
          result = await service.revokeClients();
          break;
        default:
          return res.status(400).json({ error: "Invalid AI management action" });
      }
      res.json(result);
    } catch (error) {
      console.error("[ai-lan] management failed:", error.code || "operation_failed");
      res.status(500).json({ error: "AI service operation failed" });
    }
  });
  return service;
}

module.exports = { setupAiLan };
