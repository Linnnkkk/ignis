const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const zlib = require("zlib");
const config = require("./config");
const {
  getDiscoveredPlugins,
  getVirtualPluginsForVault,
} = require("./plugin-system/manager");
const { getVersion } = require("./version");
const settings = require("./settings");
const { writeCoalescer } = require("@ignis/server-core");
const { getPending } = writeCoalescer;

// vaultId -> { response, dirMtimes, compressed: { br, gz }, etag }
const cache = new Map();

// vaultId -> Promise<entry>  (in-flight build dedup)
const pendingBuilds = new Map();

// The nonce keeps /tree ETags from repeating across server restarts.
const bootNonce = require("crypto").randomBytes(6).toString("hex");
let revisionCounter = 0;

function preCompress(buf) {
  return Promise.all([
    new Promise((resolve, reject) => {
      zlib.brotliCompress(
        buf,
        { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 } },
        (err, result) => (err ? reject(err) : resolve(result)),
      );
    }),
    new Promise((resolve, reject) => {
      zlib.gzip(buf, { level: 6 }, (err, result) =>
        err ? reject(err) : resolve(result),
      );
    }),
  ]).then(([br, gz]) => ({ br, gz }));
}

async function walkTree(rootPath) {
  const tree = {};
  const dirMtimes = {};

  async function walk(dir, prefix) {
    const stat = await fsp.stat(dir);
    dirMtimes[prefix] = stat.mtimeMs;

    const entries = await fsp.readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      const rel = prefix ? prefix + "/" + entry.name : entry.name;
      const full = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        tree[rel] = { type: "directory" };
        await walk(full, rel);
      } else {
        try {
          const buffered = getPending(full);

          if (buffered) {
            const s = await fsp.stat(full).catch(() => null);
            const size = Buffer.isBuffer(buffered.data)
              ? buffered.data.length
              : Buffer.byteLength(buffered.data, buffered.encoding || "utf-8");

            tree[rel] = {
              type: "file",
              size,
              mtime: Date.now(),
              ctime: s ? s.ctimeMs : Date.now(),
            };
          } else {
            const s = await fsp.stat(full);

            tree[rel] = {
              type: "file",
              size: s.size,
              mtime: s.mtimeMs,
              ctime: s.ctimeMs,
            };
          }
        } catch {
          tree[rel] = { type: "file" };
        }
      }
    }
  }

  await walk(rootPath, "");

  return { tree, dirMtimes };
}

function buildVaultInfo(vaultId, vaultPath) {
  return {
    id: vaultId,
    name: vaultId,
    path: vaultPath,
    platform: process.platform,
    version: config.obsidianVersion,
  };
}

function buildVaultList() {
  return Object.entries(config.vaults).map(([id, vaultPath]) => ({
    id,
    name: id,
    path: vaultPath,
  }));
}

async function dirMtimesUnchanged(vaultPath, dirMtimes) {
  const checks = await Promise.all(
    Object.entries(dirMtimes).map(async ([relDir, oldMtime]) => {
      const absDir = relDir
        ? path.join(vaultPath, relDir.split("/").join(path.sep))
        : vaultPath;

      try {
        const s = await fsp.stat(absDir);
        return s.mtimeMs === oldMtime;
      } catch {
        return false;
      }
    }),
  );

  return checks.every(Boolean);
}

async function buildEntry(vaultId) {
  const vaultPath = config.getVaultPath(vaultId);

  if (!vaultPath) {
    return null;
  }

  const cached = cache.get(vaultId);

  if (cached && (await dirMtimesUnchanged(vaultPath, cached.dirMtimes))) {
    return cached;
  }

  const t0 = Date.now();
  const etag = '"' + bootNonce + "-" + ++revisionCounter + '"';
  const vault = buildVaultInfo(vaultId, vaultPath);
  const { tree, dirMtimes } = await walkTree(vaultPath);

  const response = {
    vault,
    vaultList: buildVaultList(),
    tree,
    treeRevision: etag,
    // In demo mode, hide server-side plugins from the client.
    plugins: config.demoMode ? [] : getDiscoveredPlugins(),
    virtualPlugins: getVirtualPluginsForVault(vaultId, getVersion()),
    settings: {
      contentCacheBytes: settings.get("contentCacheBytes"),
      inputCacheBytes: settings.get("inputCacheBytes"),
      inputCacheTtlMs: settings.get("inputCacheTtlMs"),
      directFetchHosts: settings.get("directFetchHosts"),
    },
  };

  const jsonBuf = Buffer.from(JSON.stringify(response));
  let compressed = {};

  try {
    compressed = await preCompress(jsonBuf);
  } catch (e) {
    console.warn("[bootstrap] precompression failed:", e.message);
  }

  const entry = { response, dirMtimes, compressed, etag };

  cache.set(vaultId, entry);

  const ms = Date.now() - t0;
  const fileCount = Object.keys(tree).filter(
    (k) => tree[k].type === "file",
  ).length;
  const dirCount = Object.keys(dirMtimes).length;

  console.log(
    `[bootstrap] vault=${vaultId} build files=${fileCount} dirs=${dirCount} time=${ms}ms`,
  );

  return entry;
}

async function getOrBuild(vaultId) {
  if (pendingBuilds.has(vaultId)) {
    return pendingBuilds.get(vaultId);
  }

  const promise = buildEntry(vaultId).finally(() => {
    pendingBuilds.delete(vaultId);
  });

  pendingBuilds.set(vaultId, promise);

  return promise;
}

function invalidateVault(vaultId) {
  cache.delete(vaultId);
}

function invalidateAll() {
  cache.clear();
}

async function warmUp() {
  const ids = Object.keys(config.vaults);

  for (const id of ids) {
    try {
      await buildEntry(id);
    } catch (e) {
      console.warn(`[bootstrap] warm-up failed for vault ${id}:`, e.message);
    }
  }
}

module.exports = {
  walkTree,
  getOrBuild,
  invalidateVault,
  invalidateAll,
  warmUp,
};
