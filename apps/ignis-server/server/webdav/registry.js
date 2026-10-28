// Remote vault registry.
//
// Placeholders live in a hidden namespace, separate from discovered local vaults.
// They exist so existing path guards can canonicalise remote vault roots.
//
// Config file: <DATA_ROOT>/remote-vaults.json
//   {
//     "vaults": [
//       { "id": "PARA", "url": "https://host/dav/PARA",
//         "username": "u", "password": "p", "insecure": true }
//     ]
//   }
//
// Passwords stay in this file only; it is never served over HTTP.

const path = require("path");
const fs = require("fs");
const { WebdavBackend } = require("./backend");

const CONFIG_NAME = "remote-vaults.json";

let byVaultDir = new Map(); // resolved placeholder dir -> { vaultId, backend }
let byVaultId = new Map(); // vaultId -> { dir, backend }
let loadError = null;
const unmountedDirs = new Set();

function readConfig(dataRoot) {
  const file = path.join(dataRoot, CONFIG_NAME);

  let raw;

  if (Object.prototype.hasOwnProperty.call(process.env, "VITREUS_WEBDAV_RUNTIME")) {
    // The app supplies its system-vault credentials at startup only; do not
    // fall back to a disk config if the supplied value is invalid.
    raw = process.env.VITREUS_WEBDAV_RUNTIME;
    delete process.env.VITREUS_WEBDAV_RUNTIME;
  } else {
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch (e) {
      if (e.code === "ENOENT") {
        return [];
      }
      throw e;
    }
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // JSON.parse error strings can include portions of the secret-bearing input.
    throw new Error("invalid WebDAV configuration JSON");
  }
  const list = Array.isArray(parsed) ? parsed : parsed?.vaults;

  if (!Array.isArray(list)) {
    throw new Error(CONFIG_NAME + ": expected a 'vaults' array");
  }

  return list;
}

function load({ vaultRoot, dataRoot }) {
  byVaultDir = new Map();
  byVaultId = new Map();
  loadError = null;
  unmountedDirs.clear();

  let list;

  try {
    list = readConfig(dataRoot);
  } catch (e) {
    loadError = e.message;
    console.error("[webdav] Failed to read " + CONFIG_NAME + ":", e.message);
    return;
  }

  for (const spec of list) {
    if (!spec || !spec.id || !spec.url) {
      console.warn("[webdav] Skipping remote vault entry without id/url");
      continue;
    }

    if (typeof spec.id !== "string" || spec.id.trim() !== spec.id || !spec.id ||
        spec.id.startsWith(".") || /[\/\\\x00-\x1f\x7f]/.test(spec.id)) {
      // Permit ordinary Unicode names while rejecting path-like IDs.
      console.warn("[webdav] Skipping remote vault with unusable id:", spec.id);
      continue;
    }

    const localDir = path.join(vaultRoot, spec.id);
    try {
      fs.lstatSync(localDir);
      console.error("[webdav] Local entry conflicts with remote vault:", spec.id);
      continue;
    } catch (e) {
      if (e.code !== "ENOENT") {
        console.error("[webdav] Cannot check local vault:", spec.id, e.message);
        continue;
      }
    }
    if (byVaultId.has(spec.id)) {
      console.error("[webdav] Duplicate remote vault id:", spec.id);
      continue;
    }

    const mountRoot = path.resolve(vaultRoot, ".ignis-remote-vaults");
    const dir = path.join(mountRoot, spec.id);
    let backend;

    try {
      backend = new WebdavBackend(spec.url, {
        username: spec.username || "",
        password: spec.password || "",
        insecure: Boolean(spec.insecure),
      });
    } catch (e) {
      console.error("[webdav] Invalid URL for vault", spec.id, e.message);
      continue;
    }

    try {
      fs.mkdirSync(mountRoot, { recursive: true });
      if (!fs.lstatSync(mountRoot).isDirectory()) {
        throw new Error("remote mount root must be a directory, not a symlink");
      }
      fs.mkdirSync(dir, { recursive: true });
      if (!fs.lstatSync(dir).isDirectory()) {
        throw new Error("remote mount point must be a directory, not a symlink");
      }
    } catch (e) {
      console.error("[webdav] Cannot create mount point for", spec.id, e.message);
      continue;
    }

    byVaultDir.set(dir, { vaultId: spec.id, backend });
    byVaultId.set(spec.id, { dir, backend });

    console.log(
      "[webdav] Mounted remote vault",
      spec.id,
      "->",
      backend.origin + backend.basePath,
    );
  }
}

// Longest-prefix match so nested mounts would resolve correctly if ever used.
function backendForPath(absPath) {
  const resolved = path.resolve(absPath);
  for (const dir of unmountedDirs) {
    if (resolved === dir || resolved.startsWith(dir + path.sep)) {
      throw Object.assign(new Error("WebDAV vault is disabled"), { code: "ENOENT" });
    }
  }
  if (byVaultDir.size === 0) {
    return null;
  }

  const target = path.resolve(absPath);
  let best = null;

  for (const [dir, entry] of byVaultDir) {
    if (target === dir || target.startsWith(dir + path.sep)) {
      if (best === null || dir.length > best.dir.length) {
        best = { dir, entry };
      }
    }
  }

  if (best === null) {
    return null;
  }

  const rel = path
    .relative(best.dir, target)
    .split(path.sep)
    .join("/");

  return { backend: best.entry.backend, vaultId: best.entry.vaultId, rel };
}

function backendForVaultId(vaultId) {
  const entry = byVaultId.get(vaultId);

  return entry ? entry.backend : null;
}

function unmount(vaultId) {
  const entry = byVaultId.get(vaultId);
  if (entry) {
    // Keep a runtime tombstone: stale work must never fall through to disk.
    unmountedDirs.add(entry.dir);
    byVaultDir.delete(entry.dir);
    byVaultId.delete(vaultId);
  }
}

function isRemoteVault(vaultId) {
  return byVaultId.has(vaultId);
}

function list() {
  return Array.from(byVaultId.entries()).map(([vaultId, entry]) => ({
    vaultId,
    dir: entry.dir,
    url: entry.backend.origin + entry.backend.basePath,
  }));
}

function error() {
  return loadError;
}

module.exports = {
  load,
  backendForPath,
  backendForVaultId,
  isRemoteVault,
  unmount,
  list,
  error,
  CONFIG_NAME,
};
