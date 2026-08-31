function registerCacheListeners({ bootstrapCache, metadataChannel, watcher }) {
  bootstrapCache.onEntrySwapped((vaultId, revision) =>
    metadataChannel.reportReplacement(vaultId, revision),
  );

  bootstrapCache.onVaultInvalidated((vaultId) =>
    metadataChannel.forgetVault(vaultId),
  );

  watcher.addGlobalListener((vaultId, event) => {
    bootstrapCache.applyMutation(vaultId, event).then(
      (revision) => {
        try {
          metadataChannel.reportRevision(vaultId, revision);
        } catch (e) {
          console.warn(
            `[metadata] revision announce failed on vault ${vaultId}:`,
            e.message,
          );
        }
      },
      (e) =>
        console.warn(
          `[bootstrap] event apply failed on vault ${vaultId} for ${event.path}:`,
          e.message,
        ),
    );
  });
}

module.exports = { registerCacheListeners };
