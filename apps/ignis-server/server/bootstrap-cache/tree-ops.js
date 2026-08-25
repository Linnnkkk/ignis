const fs = require("fs");
const fsp = fs.promises;
const path = require("path");

function normalizeRel(p) {
  return String(p == null ? "" : p)
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/^\/+|\/+$/g, "");
}

function absOf(vaultPath, rel) {
  return rel ? path.join(vaultPath, rel.split("/").join(path.sep)) : vaultPath;
}

function fileNode(s) {
  return {
    type: "file",
    size: s.size,
    mtime: s.mtimeMs,
    ctime: s.ctimeMs,
  };
}

async function statFileNode(absPath) {
  return fileNode(await fsp.stat(absPath));
}

async function statDirMtime(absPath) {
  try {
    const s = await fsp.stat(absPath);

    return s.mtimeMs;
  } catch {
    return 0; // force invalidation
  }
}

function isRepresentable(rel) {
  return rel !== "" && !rel.split("/").includes("..");
}

function setNode(tree, rel, node) {
  const current = tree[rel];

  if (
    current &&
    current.type === node.type &&
    current.size === node.size &&
    current.mtime === node.mtime &&
    current.ctime === node.ctime
  ) {
    return false;
  }

  tree[rel] = node;

  return true;
}

async function materializeAncestors(vaultPath, entry, rel) {
  const parts = rel.split("/");
  parts.pop();

  let ancestor = "";
  let changed = false;

  for (const part of parts) {
    ancestor = ancestor ? ancestor + "/" + part : part;

    const node = entry.response.tree[ancestor];

    if (!node || node.type !== "directory") {
      entry.response.tree[ancestor] = { type: "directory" };
      changed = true;
    }

    if (!(ancestor in entry.dirMtimes)) {
      entry.dirMtimes[ancestor] = await statDirMtime(
        absOf(vaultPath, ancestor),
      );
      changed = true;
    }
  }

  return changed;
}

function subtreeKeys(map, rel) {
  const prefix = rel + "/";

  return Object.keys(map).filter(
    (key) => key === rel || key.startsWith(prefix),
  );
}

function sweepPrefix(entry, rel) {
  let changed = false;

  for (const key of subtreeKeys(entry.response.tree, rel)) {
    delete entry.response.tree[key];
    changed = true;
  }

  for (const key of subtreeKeys(entry.dirMtimes, rel)) {
    delete entry.dirMtimes[key];
    changed = true;
  }

  return changed;
}

function removePath(entry, rel) {
  const node = entry.response.tree[rel];
  // if directory, also clear children
  const isDirectory = node ? node.type === "directory" : rel in entry.dirMtimes;

  if (isDirectory) {
    return sweepPrefix(entry, rel);
  }

  if (!node) {
    return false;
  }

  delete entry.response.tree[rel];

  return true;
}

async function movePath(vaultPath, entry, from, to) {
  if (to === from) {
    return false;
  }

  const tree = entry.response.tree;
  const moved = subtreeKeys(tree, from);
  const movedDirs = subtreeKeys(entry.dirMtimes, from);

  if (moved.length === 0 && movedDirs.length === 0) {
    const s = await fsp.stat(absOf(vaultPath, to));

    if (s.isDirectory()) {
      throw new Error(`rename of an unrecorded directory: ${from}`);
    }

    const materialized = await materializeAncestors(vaultPath, entry, to);
    const stored = setNode(tree, to, fileNode(s));

    return materialized || stored;
  }

  sweepPrefix(entry, to);

  for (const key of moved) {
    tree[to + key.slice(from.length)] = tree[key];
    delete tree[key];
  }

  for (const key of movedDirs) {
    entry.dirMtimes[to + key.slice(from.length)] = entry.dirMtimes[key];
    delete entry.dirMtimes[key];
  }

  await materializeAncestors(vaultPath, entry, to);

  return true;
}

module.exports = {
  normalizeRel,
  absOf,
  fileNode,
  statFileNode,
  statDirMtime,
  isRepresentable,
  setNode,
  materializeAncestors,
  subtreeKeys,
  sweepPrefix,
  removePath,
  movePath,
};
