const {
  cache,
  crawlTokens,
  revalidateOnce,
  applyQueues,
  replayBuffers,
} = require("./state");

function cancelQueue(vaultId) {
  const queue = applyQueues.get(vaultId);

  if (queue) {
    queue.generation++;
  }
}

function invalidateVault(vaultId) {
  cache.delete(vaultId);
  revalidateOnce.delete(vaultId);
  crawlTokens.delete(vaultId); // stops a running crawl's entry from being stored.
  cancelQueue(vaultId);
  replayBuffers.delete(vaultId);
}

function invalidateAll() {
  cache.clear();
  revalidateOnce.clear();
  crawlTokens.clear();
  replayBuffers.clear();

  for (const vaultId of applyQueues.keys()) {
    cancelQueue(vaultId);
  }
}

function markForRevalidation(vaultId) {
  revalidateOnce.add(vaultId);
}

module.exports = {
  cancelQueue,
  invalidateVault,
  invalidateAll,
  markForRevalidation,
};
