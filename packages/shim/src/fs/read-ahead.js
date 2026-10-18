// Fetches uncached notes in one batch alongside a content-cache miss.

import { normalize } from "../util/path.js";
import {
  MAX_FILE_BYTES,
  fetchBatch,
  isPluginAsset,
  isTextPath,
} from "./indexer-prefetch.js";

const READ_AHEAD_FILES = 49;

function parentDir(path) {
  const slash = path.lastIndexOf("/");

  return slash < 0 ? "" : path.slice(0, slash);
}

export function createReadAhead(metadataCache, contentCache) {
  const inFlightBatchByPath = new Map();
  let inFlightBytes = 0;
  let roomNeededForLastSkippedBatch = 0;

  function freeCacheRoom() {
    return contentCache.maxSize - contentCache.currentBytes - inFlightBytes;
  }

  function isCandidate(path, missedPath) {
    if (
      path === missedPath ||
      inFlightBatchByPath.has(path) ||
      contentCache.has(path) ||
      !isTextPath(path) ||
      isPluginAsset(path)
    ) {
      return false;
    }

    const meta = metadataCache.get(path);

    return (
      !!meta &&
      meta.type === "file" &&
      meta.size > 0 &&
      meta.size <= MAX_FILE_BYTES
    );
  }

  function candidatesAround(missedPath) {
    const folder = parentDir(missedPath);
    const sameFolder = [];
    const elsewhere = [];

    for (const path of metadataCache.keys()) {
      if (sameFolder.length >= READ_AHEAD_FILES) {
        break;
      }

      if (!isCandidate(path, missedPath)) {
        continue;
      }

      if (parentDir(path) === folder) {
        sameFolder.push(path);
      } else if (elsewhere.length < READ_AHEAD_FILES) {
        elsewhere.push(path);
      }
    }

    return [...sameFolder, ...elsewhere].slice(0, READ_AHEAD_FILES);
  }

  function inFlightBatchFor(path) {
    return inFlightBatchByPath.get(normalize(path)) || null;
  }

  function fetchAround(path) {
    if (freeCacheRoom() < roomNeededForLastSkippedBatch) {
      return;
    }

    const missedPath = normalize(path);
    const paths = candidatesAround(missedPath);

    if (paths.length === 0) {
      return;
    }

    const bytes = paths.reduce((sum, p) => sum + metadataCache.get(p).size, 0);

    // Don't start a batch that would evict notes.
    if (bytes > freeCacheRoom()) {
      roomNeededForLastSkippedBatch = bytes;
      return;
    }

    roomNeededForLastSkippedBatch = 0;
    inFlightBytes += bytes;

    const pathUpdatesBefore = new Map(
      paths.map((p) => [p, contentCache.pathUpdates(p)]),
    );

    const batch = fetchBatch(window.__currentVaultId, paths)
      .then((result) => {
        for (const [p, content] of Object.entries(result.files || {})) {
          if (typeof content === "string" && pathUpdatesBefore.has(p)) {
            contentCache.setFromServer(p, content, pathUpdatesBefore.get(p));
          }
        }
      })
      .catch(() => {})
      .finally(() => {
        inFlightBytes -= bytes;

        for (const p of paths) {
          if (inFlightBatchByPath.get(p) === batch) {
            inFlightBatchByPath.delete(p);
          }
        }
      });

    for (const p of paths) {
      inFlightBatchByPath.set(p, batch);
    }
  }

  return { inFlightBatchFor, fetchAround };
}
