const fs = require("fs");
const fsp = fs.promises;
const config = require("../config");
const { cache, applyQueues, replayBuffers, nextEtag } = require("./state");
const {
  normalizeRel,
  absOf,
  statFileNode,
  isRepresentable,
  setNode,
  materializeAncestors,
  removePath,
  movePath,
} = require("./tree-ops");
const { markCompressionStale } = require("./compress");
const { invalidateVault } = require("./invalidate");

function enqueue(vaultId, task) {
  let queue = applyQueues.get(vaultId);

  if (!queue) {
    queue = { tail: Promise.resolve(), generation: 0 };
    applyQueues.set(vaultId, queue);
  }

  const generation = queue.generation;
  const gated = () => (queue.generation === generation ? task() : null);
  const run = queue.tail.then(gated, gated);
  const tail = run.catch(() => {});

  queue.tail = tail;

  tail.then(() => {
    if (applyQueues.get(vaultId) === queue && queue.tail === tail) {
      applyQueues.delete(vaultId);
    }
  });

  return run;
}

function openReplayBuffer(vaultId) {
  const buffer = [];
  let buffers = replayBuffers.get(vaultId);

  if (!buffers) {
    buffers = new Set();
    replayBuffers.set(vaultId, buffers);
  }

  buffers.add(buffer);

  return buffer;
}

function closeReplayBuffer(vaultId, buffer) {
  const buffers = replayBuffers.get(vaultId);

  if (!buffers) {
    return;
  }

  buffers.delete(buffer);

  if (buffers.size === 0) {
    replayBuffers.delete(vaultId);
  }
}

async function resolveEvent(vaultPath, event) {
  const relPath = normalizeRel(event.path);

  if (!isRepresentable(relPath)) {
    return null;
  }

  switch (event.type) {
    case "created":
    case "modified": {
      const node = event.stat
        ? {
            type: "file",
            size: event.stat.size,
            mtime: event.stat.mtime,
            ctime: event.stat.ctime,
          }
        : await statFileNode(absOf(vaultPath, relPath));

      return { type: event.type, path: relPath, node };
    }

    case "folder-created": {
      if (event.stat) {
        return { type: event.type, path: relPath, mtime: event.stat.mtime };
      }

      const s = await fsp.stat(absOf(vaultPath, relPath)).catch(() => null);

      return s ? { type: event.type, path: relPath, mtime: s.mtimeMs } : null;
    }

    case "deleted":
      return { type: event.type, path: relPath };

    case "rename": {
      const toPath = normalizeRel(event.toPath);

      return isRepresentable(toPath)
        ? { type: event.type, path: relPath, toPath }
        : null;
    }

    default:
      throw new Error(`unknown mutation type: ${event.type}`);
  }
}

async function applyMutationRecord(vaultPath, entry, mutationRecord) {
  const relPath = mutationRecord.path;

  switch (mutationRecord.type) {
    case "created":
    case "modified": {
      const materialized = await materializeAncestors(
        vaultPath,
        entry,
        relPath,
      );
      const stored = setNode(entry.response.tree, relPath, mutationRecord.node);

      return materialized || stored;
    }

    case "folder-created": {
      const materialized = await materializeAncestors(
        vaultPath,
        entry,
        relPath,
      );
      const stored = setNode(entry.response.tree, relPath, {
        type: "directory",
      });
      let recorded = false;

      if (entry.dirMtimes[relPath] !== mutationRecord.mtime) {
        entry.dirMtimes[relPath] = mutationRecord.mtime;
        recorded = true;
      }

      return materialized || stored || recorded;
    }

    case "deleted":
      return removePath(entry, relPath);

    case "rename":
      return movePath(vaultPath, entry, relPath, mutationRecord.toPath);

    default:
      throw new Error(`unknown mutation type: ${mutationRecord.type}`);
  }
}

function bumpRevision(entry) {
  entry.etag = nextEtag();
  entry.response.etag = entry.etag;
  markCompressionStale(entry);
}

function failBatch(vaultId, e) {
  console.warn(`[bootstrap] apply failed on vault ${vaultId}:`, e.message);
  invalidateVault(vaultId);

  return null;
}

async function runBatch(vaultId, batch) {
  const vaultPath = config.getVaultPath(vaultId);
  const entry = cache.get(vaultId);
  const buffers = replayBuffers.get(vaultId);

  if (!vaultPath || (!entry && !buffers)) {
    return null;
  }

  const mutationRecords = [];

  try {
    for (const event of batch) {
      const mutationRecord = await resolveEvent(vaultPath, event);

      if (mutationRecord) {
        mutationRecords.push(mutationRecord);
      }
    }
  } catch (e) {
    return failBatch(vaultId, e);
  }

  if (buffers) {
    for (const buffer of buffers) {
      buffer.push(...mutationRecords);
    }
  }

  if (!entry) {
    return null;
  }

  try {
    let changed = false;

    for (const mutationRecord of mutationRecords) {
      const applied = await applyMutationRecord(
        vaultPath,
        entry,
        mutationRecord,
      );
      changed = changed || applied;
    }

    if (changed) {
      bumpRevision(entry);
    }
  } catch (e) {
    return failBatch(vaultId, e);
  }

  return entry.etag;
}

// events: { type, path, stat?, toPath? } | { type, path, stat?, toPath? }[]
function applyMutation(vaultId, events) {
  const batch = Array.isArray(events) ? events : [events];

  return enqueue(vaultId, () => runBatch(vaultId, batch));
}

module.exports = {
  enqueue,
  openReplayBuffer,
  closeReplayBuffer,
  applyMutationRecord,
  applyMutation,
};
