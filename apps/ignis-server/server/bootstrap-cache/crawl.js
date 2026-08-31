const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const config = require("../config");
const {
  getDiscoveredPlugins,
  getVirtualPluginsForVault,
} = require("../plugin-system/manager");
const { getVersion } = require("../version");
const settings = require("../settings");
const { watcher, writeCoalescer } = require("@ignis/server-core");
const { getPending } = writeCoalescer;
const {
  cache,
  pendingBuilds,
  crawlTokens,
  revalidateOnce,
  nextEtag,
  notifyEntrySwapped,
} = require("./state");
const { absOf, fileNode } = require("./tree-ops");
const { getOrCompress, markCompressionStale } = require("./compress");
const {
  enqueue,
  openReplayBuffer,
  closeReplayBuffer,
  applyRecord,
} = require("./apply");
const { invalidateVault } = require("./invalidate");

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
            tree[rel] = fileNode(await fsp.stat(full));
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
      const absDir = absOf(vaultPath, relDir);

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

  // consume vaultid for revalidation
  const revalidate = revalidateOnce.delete(vaultId);

  if (
    cached &&
    ((watcher.isWatching(vaultId) && !revalidate) ||
      (await dirMtimesUnchanged(vaultPath, cached.dirMtimes)))
  ) {
    return cached;
  }

  const t0 = Date.now();
  const etag = nextEtag();
  const vault = buildVaultInfo(vaultId, vaultPath);
  const token = {};

  crawlTokens.set(vaultId, token);

  const buffer = openReplayBuffer(vaultId);

  try {
    const { tree, dirMtimes } = await walkTree(vaultPath);

    const response = {
      vault,
      vaultList: buildVaultList(),
      tree,
      etag,
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

    const entry = { response, dirMtimes, compressed: {}, etag };

    await getOrCompress(entry);

    await enqueue(vaultId, () =>
      swapEntry(vaultId, vaultPath, entry, buffer, token),
    );

    const ms = Date.now() - t0;
    const fileCount = Object.keys(tree).filter(
      (k) => tree[k].type === "file",
    ).length;
    const dirCount = Object.keys(dirMtimes).length;

    console.log(
      `[bootstrap] vault=${vaultId} build files=${fileCount} dirs=${dirCount} time=${ms}ms`,
    );

    return entry;
  } catch (e) {
    // failed to revalidate, schedule a revalidation on next request
    if (revalidate) {
      revalidateOnce.add(vaultId);
    }

    throw e;
  } finally {
    closeReplayBuffer(vaultId, buffer);
  }
}

async function swapEntry(vaultId, vaultPath, entry, buffer, token) {
  if (crawlTokens.get(vaultId) !== token) {
    closeReplayBuffer(vaultId, buffer);

    return;
  }

  try {
    let changed = false;

    for (const record of buffer) {
      const applied = await applyRecord(vaultPath, entry, record);
      changed = changed || applied;
    }

    if (changed) {
      markCompressionStale(entry);
    }
  } catch (e) {
    console.warn(`[bootstrap] replay failed on vault ${vaultId}:`, e.message);
    closeReplayBuffer(vaultId, buffer);
    invalidateVault(vaultId);

    return;
  }

  // An invalidation can land during the replay's own I/O.
  if (crawlTokens.get(vaultId) !== token) {
    closeReplayBuffer(vaultId, buffer);

    return;
  }

  // the buffer must close before the entry is stored.
  closeReplayBuffer(vaultId, buffer);
  crawlTokens.delete(vaultId);
  cache.set(vaultId, entry);
  notifyEntrySwapped(vaultId, entry.etag);
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

async function warmUp() {
  const ids = Object.keys(config.vaults);

  for (const id of ids) {
    try {
      await getOrBuild(id);
    } catch (e) {
      console.warn(`[bootstrap] warm-up failed for vault ${id}:`, e.message);
    }
  }
}

module.exports = {
  walkTree,
  getOrBuild,
  warmUp,
};
