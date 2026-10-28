// Change detection for mounted WebDAV vaults.
//
// A local vault is watched with chokidar, which relies on inotify. WebDAV
// exposes no change feed at all, so the only option is polling: re-read the
// tree and diff it against the previous snapshot. Depth: infinity makes a poll
// one round-trip (measured: ~120ms for a 1064-entry vault), which is why this
// is affordable at a short interval.
//
// Polling only runs while something is actually listening, so an idle server
// makes no requests at all.

const { watcher } = require("@ignis/server-core");

const DEFAULT_INTERVAL_MS = 15000;
const MIN_INTERVAL_MS = 3000;
// A mass change (branch switch, bulk import) would otherwise flood the socket.
const MAX_EVENTS_PER_POLL = 200;

const pollers = new Map(); // vaultId -> { timer, snapshot, backend, intervalMs }

function snapshotOf(tree) {
  const map = new Map();

  for (const [rel, meta] of Object.entries(tree)) {
    map.set(rel, {
      type: meta.type,
      size: meta.size || 0,
      mtime: meta.mtime || 0,
      ctime: meta.ctime || meta.mtime || 0,
    });
  }

  return map;
}

// Pure so it can be tested without a server. Returns watcher-shaped events.
function diff(previous, next) {
  const events = [];

  for (const [rel, meta] of next) {
    const before = previous.get(rel);

    if (before === undefined) {
      events.push({
        type: "created",
        path: rel,
        size: meta.size,
        mtime: meta.mtime,
        ctime: meta.ctime,
      });
      continue;
    }

    // Size and mtime are the same signals the ETag scheme uses; if either
    // moved, the file changed.
    if (before.type !== meta.type || before.size !== meta.size || before.mtime !== meta.mtime) {
      events.push({
        type: "modified",
        path: rel,
        size: meta.size,
        mtime: meta.mtime,
        ctime: meta.ctime,
      });
    }
  }

  for (const rel of previous.keys()) {
    if (!next.has(rel)) {
      events.push({ type: "deleted", path: rel });
    }
  }

  return events;
}

async function pollOnce(vaultId, entry) {
  if (!watcher.hasListeners(vaultId)) {
    return { skipped: true, events: 0 };
  }

  let listed;

  try {
    listed = await entry.backend.listTree();
    if (listed.stats?.truncated) throw new Error("WebDAV 目录扫描被截断");
  } catch (e) {
    // A transient network failure must not reset the baseline, or the next
    // successful poll would report the whole vault as newly created.
    console.warn("[webdav] Poll failed for", vaultId + ":", e.message);
    return { error: e.message, events: 0 };
  }

  if (!watcher.hasListeners(vaultId)) {
    return { skipped: true, events: 0 };
  }

  const next = snapshotOf(listed.tree);
  if (entry.snapshot === null) {
    entry.snapshot = next;
    return { events: 0, seeded: true };
  }
  const changes = diff(entry.snapshot, next);
  let emitted = 0;

  // Advance only the paths actually delivered; remaining changes stay in the
  // diff and are processed by the next poll instead of disappearing.
  for (const event of changes.slice(0, MAX_EVENTS_PER_POLL)) {
    if (!watcher.hasListeners(vaultId) || !watcher.emitEvent(vaultId, event)) break;
    if (event.type === "deleted") entry.snapshot.delete(event.path);
    else entry.snapshot.set(event.path, next.get(event.path));
    emitted++;
  }

  return { events: emitted, remaining: changes.length - emitted };
}

async function start(vaultId, backend, options = {}) {
  if (pollers.has(vaultId)) {
    return pollers.get(vaultId);
  }

  const intervalMs = Math.max(
    MIN_INTERVAL_MS,
    options.intervalMs || DEFAULT_INTERVAL_MS,
  );

  let snapshot = null;

  // Seed the baseline immediately; a missing baseline would report every
  // existing file as created on the first poll.
  try {
    const listed = await backend.listTree();
    if (listed.stats?.truncated) throw new Error("WebDAV 目录扫描被截断");

    snapshot = snapshotOf(listed.tree);
  } catch (e) {
    console.warn("[webdav] Initial snapshot failed for", vaultId + ":", e.message);
  }

  const entry = { backend, snapshot, intervalMs, timer: null, running: false };

  entry.timer = setInterval(() => {
    if (entry.running) {
      return; // a slow poll must not stack up
    }

    entry.running = true;
    pollOnce(vaultId, entry)
      .catch(() => {})
      .finally(() => {
        entry.running = false;
      });
  }, intervalMs);

  if (typeof entry.timer.unref === "function") {
    entry.timer.unref();
  }

  pollers.set(vaultId, entry);

  return entry;
}

function stop(vaultId) {
  const entry = pollers.get(vaultId);

  if (!entry) {
    return false;
  }

  clearInterval(entry.timer);
  pollers.delete(vaultId);

  return true;
}

function stopAll() {
  for (const vaultId of Array.from(pollers.keys())) {
    stop(vaultId);
  }
}

module.exports = {
  start,
  stop,
  stopAll,
  diff,
  snapshotOf,
  pollOnce,
  DEFAULT_INTERVAL_MS,
  MIN_INTERVAL_MS,
  MAX_EVENTS_PER_POLL,
};
