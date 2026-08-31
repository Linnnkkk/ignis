const {
  cache,
  crawlTokens,
  revalidateOnce,
  applyQueues,
  replayBuffers,
  notifyVaultInvalidated,
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

  notifyVaultInvalidated(vaultId);
}

function invalidateAll() {
  const cached = Array.from(cache.keys());

  cache.clear();
  revalidateOnce.clear();
  crawlTokens.clear();
  replayBuffers.clear();

  for (const vaultId of applyQueues.keys()) {
    cancelQueue(vaultId);
  }

  for (const vaultId of cached) {
    notifyVaultInvalidated(vaultId);
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
