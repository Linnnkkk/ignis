// vaultId -> { response, dirMtimes, compressed: { br, gz }, etag }
const cache = new Map();

// vaultId -> Promise<entry>  (active build dedup)
const pendingBuilds = new Map();

// vaultId -> current crawl's token
const crawlTokens = new Map();

// Set<vaultId> (forced revalidation)
const revalidateOnce = new Set();

// vaultId -> { tail, generation }, the vault's serialized task chain.
const applyQueues = new Map();

// vaultId -> Set<record[]>, one buffer per active crawl.
const replayBuffers = new Map();

// entry -> the etag of entry.compressed
const compressedEtags = new WeakMap();

// entry -> ongoing recompression.
const compressing = new WeakMap();

// Set<fn(vaultId, revision)>, fires when a crawl entry is stored.
const swapListeners = new Set();

// Set<fn(vaultId)>, fires when a vault's entry is dropped.
const invalidateListeners = new Set();

// keeps /tree ETags unique across restarts.
const bootNonce = require("crypto").randomBytes(6).toString("hex");
let revisionCounter = 0;

function nextEtag() {
  return '"' + bootNonce + "-" + ++revisionCounter + '"';
}

function notifyEntrySwapped(vaultId, revision) {
  for (const fn of swapListeners) {
    try {
      fn(vaultId, revision);
    } catch (e) {
      console.error("[bootstrap] swap listener error:", e.message);
    }
  }
}

function notifyVaultInvalidated(vaultId) {
  for (const fn of invalidateListeners) {
    try {
      fn(vaultId);
    } catch (e) {
      console.error("[bootstrap] invalidate listener error:", e.message);
    }
  }
}

function onEntrySwapped(fn) {
  swapListeners.add(fn);
}

function onVaultInvalidated(fn) {
  invalidateListeners.add(fn);
}

module.exports = {
  cache,
  pendingBuilds,
  crawlTokens,
  revalidateOnce,
  applyQueues,
  replayBuffers,
  compressedEtags,
  compressing,
  nextEtag,
  notifyEntrySwapped,
  notifyVaultInvalidated,
  onEntrySwapped,
  onVaultInvalidated,
};
