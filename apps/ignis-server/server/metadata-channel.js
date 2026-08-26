// Announces the revision of a vault's stored tree over the metadata channel.

const CHANNEL = "metadata";

const REVISION_DEBOUNCE_MS = 250;

function createMetadataChannel(wss) {
  const channel = wss.channel(CHANNEL);

  // vaultId -> { revision: announced or pending, timer }
  const state = new Map();

  function stateOf(vaultId) {
    let entry = state.get(vaultId);

    if (!entry) {
      entry = { revision: null, timer: null };
      state.set(vaultId, entry);
    }

    return entry;
  }

  function noteRevision(vaultId, revision) {
    if (!revision) {
      return;
    }

    const entry = stateOf(vaultId);

    if (entry.revision === revision) {
      return;
    }

    entry.revision = revision;
    clearTimeout(entry.timer);

    entry.timer = setTimeout(() => {
      entry.timer = null;
      channel.broadcastToVault(vaultId, {
        type: "revision",
        revision: entry.revision,
      });
    }, REVISION_DEBOUNCE_MS);

    entry.timer.unref?.();
  }

  function noteReplaced(vaultId, revision) {
    const entry = stateOf(vaultId);

    clearTimeout(entry.timer);
    entry.timer = null;
    entry.revision = revision;

    channel.broadcastToVault(vaultId, { type: "replaced", revision });
  }

  function forgetVault(vaultId) {
    const entry = state.get(vaultId);

    if (!entry) {
      return;
    }

    clearTimeout(entry.timer);
    state.delete(vaultId);
  }

  return { noteRevision, noteReplaced, forgetVault };
}

module.exports = { createMetadataChannel };
