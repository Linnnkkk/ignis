const crypto = require("crypto");
const fs = require("fs");
const https = require("https");
const net = require("net");
const path = require("path");
const dgram = require("dgram");
const { createAccessPolicy } = require('./access');
const { createBackupStore } = require('./backups');
const { parseNote } = require('./metadata');
const { createQueries } = require('./query');
const { inspectFile } = require('./inspect');

const configDefault = require("../config");
const tlsCertDefault = require("../tls-cert");
const { writeCoalescer: coalescerDefault } = require("@ignis/server-core");
const cacheDefault = require("../cache");

const DISCOVERY_PORT = 39871;
const PAIRING_TTL_MS = 2 * 60 * 1000;
const PAIRING_RATE_WINDOW_MS = 60 * 1000;
const PAIRING_RATE_LIMIT = 30;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_LIST_ENTRIES = 500;
const MAX_SEARCH_FILES = 500;
const MAX_SEARCH_ENTRIES = 10000;
const MAX_SEARCH_BYTES = 8 * 1024 * 1024;
const MAX_SEARCH_MATCHES = 100;
const MAX_SEARCH_DEPTH = 32;
const MAX_CLIENTS = 100;

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function send(res, status, value) {
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": body.length,
    "cache-control": "no-store",
    pragma: "no-cache",
    expires: "0",
    "x-content-type-options": "nosniff",
  });
  res.end(body);
}

function error(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function isLanAddress(address) {
  const ip = String(address || "").replace(/^::ffff:/, "").split("%", 1)[0];
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 10 || a === 127 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127);
  }
  if (net.isIPv6(ip)) {
    const normalized = ip.toLowerCase();
    return normalized === "::1" || normalized.startsWith("fc") ||
      normalized.startsWith("fd") || normalized.startsWith("fe8") ||
      normalized.startsWith("fe9") || normalized.startsWith("fea") ||
      normalized.startsWith("feb");
  }
  return false;
}

function createAiLanService(options = {}) {
  const config = options.config || configDefault;
  const tlsCert = options.tlsCert || tlsCertDefault;
  const coalescer = options.writeCoalescer || coalescerDefault;
  const cache = options.bootstrapCache || cacheDefault;
  const dataDir = path.join(config.dataRoot, "ai-lan");
  const tlsDir = path.join(dataDir, "tls");
  const keyFile = path.join(tlsDir, "key.pem");
  const certFile = path.join(tlsDir, "cert.pem");
  const deviceFile = path.join(dataDir, "device-id");
  const clientsFile = path.join(dataDir, "clients.json");
  const access = createAccessPolicy(dataDir, () => config.vaults || {});
  const backups = createBackupStore(dataDir);
  const queries = createQueries({ scan: scanNotes, read, parseNote });

  let deviceId;
  let clients = [];
  // Never reload old grants after a failed revocation in this service instance.
  let revocationPending = false;
  let server = null;
  let discovery = null;
  let discoveryAvailable = false;
  let discoveryError = "";
  let port = 0;
  let fingerprint = "";
  let activeIps = [];
  let pairingSecret = null;
  let pairingExpiresAt = 0;
  let accepting = false;
  let shuttingDown = false;
  let rateWindow = 0;
  let rateCount = 0;
  let sessionGeneration = 0;
  let operationQueue = Promise.resolve();
  const sockets = new Set();

  function serialize(task) {
    const result = operationQueue.then(task, task);
    operationQueue = result.catch(() => {});
    return result;
  }

  function status() {
    return {
      running: !!server && accepting && !revocationPending,
      port: server && accepting && !revocationPending ? port : 0,
      deviceId: deviceId || "",
      fingerprint: fingerprint || "",
      pairingExpiresAt: pairingSecret ? pairingExpiresAt : 0,
      pairedClients: clients.length,
      discoveryAvailable,
      discoveryError,
      access: access.status(),
      availableVaults: Object.keys(config.vaults || {}).map(id => ({ id })),
    };
  }

  function ensureIdentity() {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    try {
      deviceId = fs.readFileSync(deviceFile, "utf8").trim();
      if (!/^[0-9a-f-]{36}$/i.test(deviceId)) throw new Error("invalid device id");
    } catch {
      deviceId = crypto.randomUUID();
      fs.writeFileSync(deviceFile, `${deviceId}\n`, { mode: 0o600, flag: "wx" });
    }
    try {
      if (fs.statSync(clientsFile).size > 256 * 1024) throw new Error("client file too large");
      const parsed = JSON.parse(fs.readFileSync(clientsFile, "utf8"));
      clients = Array.isArray(parsed) ? parsed.filter((item) =>
        item && /^[0-9a-f]{64}$/.test(item.tokenHash) &&
        typeof item.name === "string" && Number.isFinite(item.createdAt),
      ).slice(0, MAX_CLIENTS) : [];
    } catch {
      clients = [];
    }
  }

  function saveClients() {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const temp = `${clientsFile}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(clients), { mode: 0o600, flag: "wx" });
    fs.renameSync(temp, clientsFile);
  }

  function getTls() {
    fs.mkdirSync(tlsDir, { recursive: true, mode: 0o700 });
    let key;
    let cert;
    try {
      key = fs.readFileSync(keyFile, "utf8");
      cert = fs.readFileSync(certFile, "utf8");
      const x509 = new crypto.X509Certificate(cert);
      const publicKey = crypto.createPublicKey(key).export({ type: "spki", format: "der" });
      const certKey = x509.publicKey.export({ type: "spki", format: "der" });
      if (Date.parse(x509.validTo) <= Date.now() || !x509.verify(x509.publicKey) || !publicKey.equals(certKey)) {
        throw new Error("expired or invalid certificate");
      }
      fingerprint = x509.fingerprint256;
    } catch {
      const generated = tlsCert.generate([]);
      key = generated.key;
      cert = generated.cert;
      fs.writeFileSync(keyFile, key, { mode: 0o600 });
      fs.writeFileSync(certFile, cert, { mode: 0o600 });
      fingerprint = new crypto.X509Certificate(cert).fingerprint256;
    }
    return { key, cert };
  }

  function startDiscovery() {
    const socket = dgram.createSocket("udp4");
    discovery = socket;
    discoveryAvailable = false;
    discoveryError = "";
    let windowStart = 0;
    let windowCount = 0;
    socket.on("message", (message, remote) => {
      if (!isLanAddress(remote.address) || message.length > 512) return;
      const now = Date.now();
      if (now - windowStart >= 1000) {
        windowStart = now;
        windowCount = 0;
      }
      if (++windowCount > 20) return;
      let request;
      try {
        request = JSON.parse(message.toString("utf8"));
      } catch {
        return;
      }
      if (request?.type !== "vitreus-ai-discover" || request.version !== 1 ||
          typeof request.nonce !== "string" || request.nonce.length < 1 ||
          request.nonce.length > 128) return;
      const response = Buffer.from(JSON.stringify({
        type: "vitreus-ai-service",
        version: 1,
        nonce: request.nonce,
        deviceId,
        port,
      }));
      if (response.length <= 512) socket.send(response, remote.port, remote.address);
    });
    socket.once("error", (err) => {
      discoveryAvailable = false;
      // Expose only the OS error code, never secrets or filesystem paths.
      discoveryError = typeof err.code === "string" ? err.code : "UDP_ERROR";
      console.warn("[ai-lan] discovery unavailable:", discoveryError);
      if (discovery === socket) discovery = null;
      try { socket.close(); } catch { /* Socket may already be closed. */ }
    });
    socket.bind(DISCOVERY_PORT, "0.0.0.0", () => {
      if (discovery === socket) discoveryAvailable = true;
    });
  }

  function currentVault(vaultId) {
    if (typeof vaultId !== "string" || !vaultId ||
        !Object.prototype.hasOwnProperty.call(config.vaults || {}, vaultId)) {
      throw error("NOT_FOUND", "Vault not found");
    }
    if (!access.allows(vaultId)) throw error('FORBIDDEN', 'Obsidian vault is not authorized by the phone owner');
    const root = config.getVaultPath(vaultId);
    if (!root) throw error("NOT_FOUND", "Vault not found");
    const resolvedRoot = fs.realpathSync(root);
    const privateRoot = path.resolve(dataDir);
    if (privateRoot === resolvedRoot || privateRoot.startsWith(resolvedRoot + path.sep)) throw error('FORBIDDEN', 'Private AI storage must be outside the vault');
    const stat = fs.lstatSync(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw error("FORBIDDEN", "Invalid vault path");
    return { vaultId, root: path.resolve(root) };
  }

  function cleanParts(input, { file = true } = {}) {
    if (typeof input !== "string" || input.length > 1024 || input.includes("\0") ||
        input.includes("\\") || path.posix.isAbsolute(input) || /^[A-Za-z]:/.test(input)) {
      throw error("BAD_REQUEST", "Invalid path");
    }
    const parts = input.split("/").filter((part) => part && part !== ".");
    if (parts.some((part) => part === ".." || part.startsWith(".") || part.toLowerCase() === ".obsidian")) {
      throw error("FORBIDDEN", "Path is not allowed");
    }
    if (file && (!parts.length || !parts.at(-1).endsWith(".md"))) {
      throw error("FORBIDDEN", "Only Markdown files are allowed");
    }
    return parts;
  }

  function resolvePath(vault, parts, { allowMissingFinal = false } = {}) {
    let current = vault.root;
    for (let index = 0; index < parts.length; index++) {
      current = path.join(current, parts[index]);
      if (!current.startsWith(vault.root + path.sep)) throw error("FORBIDDEN", "Path is not allowed");
      try {
        const stat = fs.lstatSync(current);
        if (stat.isSymbolicLink()) throw error("FORBIDDEN", "Symbolic links are not allowed");
        if (index < parts.length - 1 && !stat.isDirectory()) throw error("NOT_FOUND", "Path not found");
      } catch (err) {
        if (err.code === "ENOENT" && allowMissingFinal && index === parts.length - 1) continue;
        throw err.code ? err : error("NOT_FOUND", "Path not found");
      }
    }
    return current;
  }

  function assertOpen() {
    if (!accepting || shuttingDown || revocationPending) throw error("UNAVAILABLE", "AI-LAN service is disabled");
  }

  function assertSession(generation, tokenHash) {
    assertOpen();
    if (sessionGeneration !== generation || !clients.some((client) => client.tokenHash === tokenHash)) {
      throw error("UNAUTHORIZED", "AI-LAN session is no longer authorized");
    }
  }

  function readCurrent(absolute) {
    const pending = coalescer.getPending?.(absolute);
    if (pending) {
      if ((Buffer.isBuffer(pending.data) ? pending.data.length : Buffer.byteLength(String(pending.data))) > MAX_FILE_BYTES) throw error('LIMIT_EXCEEDED', 'Pending note exceeds size limit');
      const buffer = coalescer.pendingBuffer(pending.data, pending.encoding);
      if (buffer.length > MAX_FILE_BYTES) throw error('LIMIT_EXCEEDED', 'Pending note exceeds size limit');
      return buffer.toString('utf8');
    }
    return fs.readFileSync(absolute, "utf8");
  }

  function requireObject(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw error("BAD_REQUEST", "Expected an object");
    return value;
  }

  async function listFiles(params) {
    const vault = currentVault(params.vaultId);
    const parts = params.path ? cleanParts(params.path, { file: false }) : [];
    const directory = parts.length ? resolvePath(vault, parts) : vault.root;
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory()) throw error("BAD_REQUEST", "Path is not a directory");
    const entries = fs.readdirSync(directory, { withFileTypes: true });
    if (entries.length > MAX_LIST_ENTRIES) throw error("LIMIT_EXCEEDED", "Directory has too many entries");
    const result = [];
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name.toLowerCase() === ".obsidian" || entry.isSymbolicLink()) continue;
      if (!entry.isDirectory() && !(entry.isFile() && entry.name.endsWith(".md"))) continue;
      result.push({ name: entry.name, type: entry.isDirectory() ? "directory" : "file" });
      if (result.length > MAX_LIST_ENTRIES) throw error("LIMIT_EXCEEDED", "Directory has too many entries");
    }
    return result;
  }

  function scanNotes(params) {
    const vault = currentVault(params.vaultId);
    const result = [];
    let entries = 0;
    let bytes = 0;
    function walk(directory, prefix, depth) {
      assertOpen();
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (++entries > MAX_SEARCH_ENTRIES) throw error('LIMIT_EXCEEDED', 'Vault entry budget exceeded');
        if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
        const absolute = resolvePath(vault, relative.split('/'));
        if (entry.isDirectory()) {
          if (depth >= MAX_SEARCH_DEPTH) throw error('LIMIT_EXCEEDED', 'Vault depth budget exceeded');
          walk(absolute, relative, depth + 1);
        } else if (entry.isFile() && entry.name.endsWith('.md')) {
          if (result.length >= MAX_SEARCH_FILES || fs.statSync(absolute).size > MAX_FILE_BYTES) throw error('LIMIT_EXCEEDED', 'Vault file budget exceeded');
          const content = readCurrent(absolute);
          if (Buffer.byteLength(content) > MAX_FILE_BYTES || (bytes += Buffer.byteLength(content)) > MAX_SEARCH_BYTES) throw error('LIMIT_EXCEEDED', 'Vault byte budget exceeded');
          result.push({ path: relative, content, revision: sha256(content), modifiedAt: fs.statSync(absolute).mtimeMs });
        }
      }
    }
    walk(vault.root, '', 0);
    return result.sort((a, b) => a.path.localeCompare(b.path));
  }

  async function searchFiles(params) {
    if (typeof params.query !== "string" || !params.query || params.query.length > 256) {
      throw error("BAD_REQUEST", "Invalid search query");
    }
    const vault = currentVault(params.vaultId);
    const results = [];
    let visited = 0;
    let entriesVisited = 0;
    let bytesRead = 0;
    const walk = (directory, rel, depth) => {
      assertOpen();
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (++entriesVisited > MAX_SEARCH_ENTRIES) throw error("LIMIT_EXCEEDED", "Search entry limit exceeded");
        if (entry.name.startsWith(".") || entry.name.toLowerCase() === ".obsidian" || entry.isSymbolicLink()) continue;
        const relPath = rel ? `${rel}/${entry.name}` : entry.name;
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          if (depth >= MAX_SEARCH_DEPTH) throw error("LIMIT_EXCEEDED", "Search depth limit exceeded");
          walk(absolute, relPath, depth + 1);
        } else if (entry.isFile() && entry.name.endsWith(".md")) {
          if (++visited > MAX_SEARCH_FILES) throw error("LIMIT_EXCEEDED", "Search file limit exceeded");
          const stat = fs.statSync(absolute);
          if (!stat.isFile()) throw error("BAD_REQUEST", "Path is not a file");
          if (!coalescer.getPending?.(absolute) && stat.size > MAX_FILE_BYTES) {
            throw error("LIMIT_EXCEEDED", "Search size limit exceeded");
          }
          const content = readCurrent(absolute);
          if ((bytesRead += Buffer.byteLength(content)) > MAX_SEARCH_BYTES) throw error("LIMIT_EXCEEDED", "Search size limit exceeded");
          const index = content.toLocaleLowerCase().indexOf(params.query.toLocaleLowerCase());
          if (index >= 0) {
            results.push({ path: relPath, excerpt: content.slice(Math.max(0, index - 80), index + params.query.length + 160) });
            if (results.length >= MAX_SEARCH_MATCHES) return;
          }
        }
        if (results.length >= MAX_SEARCH_MATCHES) return;
      }
    };
    walk(vault.root, "", 0);
    return results;
  }

  function read(params) {
    const vault = currentVault(params.vaultId);
    const parts = cleanParts(params.path);
    const absolute = resolvePath(vault, parts);
    const stat = fs.statSync(absolute);
    if (!stat.isFile()) throw error("BAD_REQUEST", "Path is not a file");
    if (!coalescer.getPending?.(absolute) && stat.size > MAX_FILE_BYTES) throw error('LIMIT_EXCEEDED', 'File is too large');
    const content = readCurrent(absolute);
    if (Buffer.byteLength(content) > MAX_FILE_BYTES) throw error("LIMIT_EXCEEDED", "File is too large");
    return { path: parts.join("/"), content, revision: sha256(content) };
  }

  async function mutate(method, params, tokenHash, generation) {
    assertOpen();
    assertSession(generation, tokenHash);
    const vault = currentVault(params.vaultId);
    if (!access.allows(params.vaultId, true)) throw error('FORBIDDEN', 'Obsidian vault is read-only');
    const parts = cleanParts(params.path);
    const absolute = resolvePath(vault, parts, { allowMissingFinal: method === "create" });
    let committedContent;
    if (method === "create") {
      if (typeof params.content !== "string" || Buffer.byteLength(params.content) > MAX_FILE_BYTES) {
        throw error("BAD_REQUEST", "Invalid content");
      }
      if (!accepting) throw error("UNAVAILABLE", "AI-LAN service is disabled");
      fs.writeFileSync(absolute, params.content, { encoding: "utf8", flag: "wx" });
      committedContent = params.content;
    } else {
      if (typeof params.expectedRevision !== "string" || !/^[0-9a-f]{64}$/.test(params.expectedRevision)) {
        throw error("BAD_REQUEST", "expectedRevision is required");
      }
      if (method === "edit" && (typeof params.content !== "string" || Buffer.byteLength(params.content) > MAX_FILE_BYTES)) {
        throw error("BAD_REQUEST", "Invalid content");
      }
      if (method === "append" && (typeof params.content !== "string" || Buffer.byteLength(params.content) > MAX_FILE_BYTES)) {
        throw error("BAD_REQUEST", "Invalid content");
      }
      await coalescer.flushPending(absolute);
      assertSession(generation, tokenHash);
      resolvePath(vault, parts);
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_FILE_BYTES) {
        throw error("FORBIDDEN", "Invalid Markdown file");
      }
      const current = fs.readFileSync(absolute, "utf8");
      if (sha256(current) !== params.expectedRevision) throw error("CONFLICT", "Revision does not match");
      let content = method === "append" ? current + params.content : params.content;
      if (method === 'patch') {
        if (typeof params.oldText !== 'string' || !params.oldText || typeof params.newText !== 'string') throw error('BAD_REQUEST', 'oldText and newText required');
        const first = current.indexOf(params.oldText);
        if (first < 0 || current.indexOf(params.oldText, first + 1) >= 0) throw error('CONFLICT', 'oldText must match exactly once');
        content = current.slice(0, first) + params.newText + current.slice(first + params.oldText.length);
      }
      if (method === 'restore') content = backups.read({ vaultId: params.vaultId, path: parts.join('/'), backupId: params.backupId }).content;
      if (typeof content !== 'string') throw error('BAD_REQUEST', 'Invalid content');
      if (Buffer.byteLength(content) > MAX_FILE_BYTES) throw error("LIMIT_EXCEEDED", "File is too large");
      assertSession(generation, tokenHash);
      backups.save({ vaultId: params.vaultId, path: parts.join('/'), content: current, revision: sha256(current) });
      const temporary = path.join(path.dirname(absolute), `.ai-${crypto.randomUUID()}.tmp`);
      try {
        fs.writeFileSync(temporary, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
        fs.renameSync(temporary, absolute);
        committedContent = content;
      } finally {
        if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
      }
    }
    const result = { path: parts.join("/"), revision: sha256(committedContent) };
    try {
      await cache.applyMutation(vault.vaultId, {
        type: method === "create" ? "created" : "modified",
        path: parts.join("/"),
      });
    } catch {
      // The file is already committed. Never replay the write or leak cache errors.
      return { ...result, committed: true, warning: "CACHE_REFRESH_FAILED" };
    }
    return result;
  }

  async function rpc(method, params, tokenHash, generation) {
    requireObject(params);
    switch (method) {
      case "vaults":
        return Object.keys(config.vaults || {}).filter((id) => access.allows(id) && config.getVaultPath(id)).map((id) => ({ id, type: 'obsidian-vault', readOnly: !access.allows(id, true) }));
      case "list": return listFiles(params);
      case "search": return searchFiles(params);
      case "read": return read(params);
      case 'inspect': {
        const vault = currentVault(params.vaultId);
        const parts = cleanParts(params.path, { file: false });
        if (!parts.length) throw error('BAD_REQUEST', 'File path required');
        return inspectFile(resolvePath(vault, parts), parts.join('/'));
      }
      case 'tasks': return queries.tasks(params);
      case 'outline': return queries.outline(params);
      case 'read_lines': return queries.readLines(params);
      case 'metadata': return queries.metadata(params);
      case 'query': return queries.query(params);
      case 'tags': return queries.tags(params);
      case 'links': return queries.links(params);
      case 'backlinks': return queries.backlinks(params);
      case 'backups': {
        currentVault(params.vaultId);
        const parts = cleanParts(params.path);
        return backups.list({ vaultId: params.vaultId, path: parts.join('/') });
      }
      case 'patch':
      case 'restore':
      case "create":
      case "edit":
      case "append": return mutate(method, params, tokenHash, generation);
      default: throw error("METHOD_NOT_FOUND", "Unknown method");
    }
  }

  function rateAllowed() {
    const now = Date.now();
    if (now - rateWindow >= PAIRING_RATE_WINDOW_MS) {
      rateWindow = now;
      rateCount = 0;
    }
    return ++rateCount <= PAIRING_RATE_LIMIT;
  }

  async function readBody(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) throw error("PAYLOAD_TOO_LARGE", "Request body too large");
      chunks.push(chunk);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw error("BAD_REQUEST", "Invalid JSON");
    }
  }

  async function handle(req, res) {
    if (!isLanAddress(req.socket.remoteAddress)) return send(res, 403, { error: { code: "LAN_REQUIRED", message: "LAN source address required" } });
    if (req.headers.origin !== undefined) return send(res, 403, { error: { code: "ORIGIN_REJECTED", message: "Origin is not allowed" } });
    let parsedUrl;
    try { parsedUrl = new URL(req.url, "https://ai-lan.invalid"); }
    catch { return send(res, 400, { error: { code: 'BAD_REQUEST', message: 'Invalid request URL' } }); }
    if (parsedUrl.search || req.url.includes("?")) return send(res, 400, { error: { code: "BAD_REQUEST", message: "URL query parameters are not allowed" } });
    const pathname = parsedUrl.pathname;
    if (req.method !== "POST" || !["/pair", "/rpc"].includes(pathname)) return send(res, 404, { error: { code: "NOT_FOUND", message: "Not found" } });
    try {
      if (!accepting || shuttingDown || revocationPending) throw error("UNAVAILABLE", "AI-LAN service is disabled");
      const body = requireObject(await readBody(req));
      if (!accepting || shuttingDown || revocationPending) throw error("UNAVAILABLE", "AI-LAN service is disabled");
      if (pathname === "/pair") {
        if (!rateAllowed()) throw error("RATE_LIMITED", "Pairing rate limit exceeded");
        if (!pairingSecret || Date.now() >= pairingExpiresAt) {
          pairingSecret = null;
          pairingExpiresAt = 0;
          throw error("PAIRING_EXPIRED", "Pairing code expired");
        }
        if (typeof body.clientName !== "string" || !body.clientName.trim() || body.clientName.length > 80 || typeof body.pairingCode !== "string") {
          throw error("BAD_REQUEST", "clientName and pairingCode are required");
        }
        const supplied = Buffer.from(sha256(body.pairingCode), "hex");
        const expected = Buffer.from(sha256(pairingSecret), "hex");
        if (!crypto.timingSafeEqual(supplied, expected)) throw error("INVALID_PAIRING", "Pairing code is invalid");
        if (clients.length >= MAX_CLIENTS) throw error("LIMIT_EXCEEDED", "Paired client limit reached");
        pairingSecret = null;
        pairingExpiresAt = 0;
        const token = crypto.randomBytes(32).toString("base64url");
        clients.push({ tokenHash: sha256(token), name: body.clientName.trim(), createdAt: Date.now() });
        saveClients();
        return send(res, 200, { token });
      }
      const authorization = req.headers.authorization || "";
      const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(authorization);
      if (!match) throw error("UNAUTHORIZED", "Bearer token required");
      const tokenHash = sha256(match[1]);
      const valid = clients.some((client) => crypto.timingSafeEqual(Buffer.from(client.tokenHash, "hex"), Buffer.from(tokenHash, "hex")));
      if (!valid) throw error("UNAUTHORIZED", "Invalid bearer token");
      if (typeof body.method !== "string") throw error("BAD_REQUEST", "method is required");
      const generation = sessionGeneration;
      const result = await rpc(body.method, body.params || {}, tokenHash, generation);
      return send(res, 200, { result });
    } catch (err) {
      const codes = { BAD_REQUEST: 400, NOT_FOUND: 404, FORBIDDEN: 403, UNAUTHORIZED: 401, INVALID_PAIRING: 401, PAIRING_EXPIRED: 410, RATE_LIMITED: 429, PAYLOAD_TOO_LARGE: 413, LIMIT_EXCEEDED: 413, CONFLICT: 409, METHOD_NOT_FOUND: 404, UNAVAILABLE: 503 };
      return send(res, codes[err.code] || 500, { error: { code: err.code || "INTERNAL", message: codes[err.code] ? err.message : "Internal server error" } });
    }
  }

  async function enable({ ips = [], port: requestedPort } = {}) {
    return serialize(async () => {
      if (revocationPending) commitRevocation();
      shuttingDown = false;
      ensureIdentity();
      if (server && accepting) return status();
      activeIps = [...new Set(ips.filter((ip) => typeof ip === "string" && net.isIP(ip)))];
      const tls = getTls();
      const httpsServer = https.createServer(tls, (req, res) => {
        void handle(req, res).catch(() => {
          if (!res.headersSent) send(res, 500, { error: { code: 'INTERNAL_ERROR', message: 'Request failed' } });
          else res.destroy();
        });
      });
      httpsServer.headersTimeout = 10_000;
      httpsServer.requestTimeout = 30_000;
      httpsServer.timeout = 30_000;
      httpsServer.maxConnections = 64;
      httpsServer.on("connection", (socket) => {
        sockets.add(socket);
        socket.once("close", () => sockets.delete(socket));
      });
      server = httpsServer;
      accepting = true;
      try {
        await new Promise((resolve, reject) => {
          httpsServer.once("error", reject);
          httpsServer.listen(Number(requestedPort) > 0 ? Number(requestedPort) : 0, "0.0.0.0", resolve);
        });
      } catch (err) {
        accepting = false;
        server = null;
        throw err;
      }
      port = httpsServer.address().port;
      startDiscovery();
      return status();
    });
  }

  async function disable() {
    sessionGeneration++;
    shuttingDown = true;
    accepting = false;
    pairingSecret = null;
    pairingExpiresAt = 0;
    return serialize(async () => {
      const oldServer = server;
      server = null;
      port = 0;
      discoveryAvailable = false;
      const oldDiscovery = discovery;
      discovery = null;
      if (oldDiscovery) oldDiscovery.close();
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      if (oldServer) {
        if (typeof oldServer.closeAllConnections === "function") oldServer.closeAllConnections();
        await new Promise((resolve) => {
          let settled = false;
          const finish = () => { if (!settled) { settled = true; clearTimeout(timer); resolve(); } };
          const timer = setTimeout(finish, 1000);
          oldServer.close(finish);
        });
      }
      shuttingDown = false;
      return status();
    });
  }

  function createPairing() {
    assertOpen();
    pairingSecret = crypto.randomBytes(32).toString("base64url");
    pairingExpiresAt = Date.now() + PAIRING_TTL_MS;
    return {
      version: 1,
      deviceId,
      address: activeIps[0] || "127.0.0.1",
      port,
      fingerprint,
      pairingCode: pairingSecret,
      pairingExpiresAt,
    };
  }

  function commitRevocation() {
    try {
      saveClients();
      revocationPending = false;
    } catch {
      throw error('REVOCATION_FAILED', 'Client revocation could not be persisted; AI-LAN is blocked until retry succeeds');
    }
  }

  function revokeClients() {
    sessionGeneration++;
    clients = [];
    pairingSecret = null;
    pairingExpiresAt = 0;
    revocationPending = true;
    commitRevocation();
    return status();
  }

  function setAccess(policy) {
    access.update(policy);
    sessionGeneration++;
    return status();
  }
  return { enable, disable, status, createPairing, revokeClients, setAccess };
}

module.exports = { createAiLanService };
