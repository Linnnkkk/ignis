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

// keeps /tree ETags unique across restarts.
const bootNonce = require("crypto").randomBytes(6).toString("hex");
let revisionCounter = 0;

function nextEtag() {
  return '"' + bootNonce + "-" + ++revisionCounter + '"';
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
};
