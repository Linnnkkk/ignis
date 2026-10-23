const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const MAX_CONTENT_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const MAX_BACKUPS = 1024;
// JSON escaping can expand a UTF-8 content byte to six bytes.
const MAX_RECORD_BYTES = MAX_CONTENT_BYTES * 6 + 16 * 1024;
const ID_PATTERN = /^[0-9a-f]{32}$/;
const FILE_PATTERN = /^[0-9a-f]{32}\.json$/;

function fail(code, message) {
  return Object.assign(new Error(message), { code });
}

function hasControl(value) {
  return [...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
}

function validateBinding(vaultId, notePath) {
  if (typeof vaultId !== "string" || !vaultId || Buffer.byteLength(vaultId) > 256 ||
      /[\\/:]/.test(vaultId) || hasControl(vaultId) || vaultId === "." || vaultId === ".." ||
      typeof notePath !== "string" || !notePath || Buffer.byteLength(notePath) > 4096 ||
      /[\\:]/.test(notePath) || hasControl(notePath) || /%(?:2e|2f|5c|00)/i.test(notePath) ||
      notePath.split("/").some((part) => !part || part === "." || part === "..")) {
    throw fail("INVALID_ARGUMENT", "Invalid backup vaultId or relative path");
  }
}

function metadata(record) {
  const { backupId, vaultId, path: notePath, revision, createdAt, bytes } = record;
  return { backupId, vaultId, path: notePath, revision, createdAt, bytes };
}

/**
 * Private, synchronous snapshot storage, independent of vault filesystem paths.
 * save/list/read may also be awaited. The caller must authorize vault/path before
 * every call; restoration and CAS checks belong to the main service, not here.
 * A crashed writer's lock/temp files fail closed (manual operator repair only).
 * dataDir must be trusted app-private storage outside every vault. Like other
 * Node pathname APIs, this does not defend against a malicious same-UID process
 * concurrently replacing ancestor directories.
 */
function createBackupStore(dataDir) {
  if (typeof dataDir !== "string" || !dataDir || dataDir.includes("\0")) {
    throw fail("INVALID_ARGUMENT", "Invalid backup data directory");
  }
  const root = path.join(path.resolve(dataDir), "backups");
  const lockPath = path.join(root, ".lock");

  function ensureRoot() {
    // Check every ancestor, not only the final component: mkdir recursive and
    // realpath alone would silently follow symlinks supplied in dataDir.
    const parsed = path.parse(root);
    let current = parsed.root;
    for (const component of root.slice(parsed.root.length).split(path.sep)) {
      current = path.join(current, component);
      try {
        fs.mkdirSync(current, { mode: 0o700 });
      } catch (err) {
        if (err.code !== "EEXIST") throw err;
      }
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw fail("BACKUP_STORE_UNSAFE", "Backup storage contains an unsafe directory");
      }
    }
    fs.chmodSync(root, 0o700);
  }

  function withLock(task) {
    ensureRoot();
    let lock;
    try {
      lock = fs.openSync(lockPath, fs.constants.O_WRONLY | fs.constants.O_CREAT |
        fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    } catch (err) {
      if (err.code === "EEXIST" || err.code === "ELOOP") {
        const stat = fs.lstatSync(lockPath);
        throw fail(stat.isSymbolicLink() ? "BACKUP_STORE_UNSAFE" : "BACKUP_STORE_BUSY", "Backup storage is locked");
      }
      throw err;
    }
    try {
      return task();
    } finally {
      fs.closeSync(lock);
      fs.unlinkSync(lockPath);
    }
  }

  function inventory() {
    let total = 0;
    const files = [];
    for (const name of fs.readdirSync(root)) {
      if (name === ".lock") continue;
      const filename = path.join(root, name);
      const stat = fs.lstatSync(filename);
      if (!FILE_PATTERN.test(name) || !stat.isFile() || stat.isSymbolicLink() ||
          stat.nlink !== 1 || (stat.mode & 0o077) !== 0 || stat.size > MAX_RECORD_BYTES) {
        throw fail("BACKUP_STORE_UNSAFE", "Backup storage contains an unsafe entry");
      }
      total += stat.size;
      files.push({ name, size: stat.size });
      if (total > MAX_TOTAL_BYTES || files.length > MAX_BACKUPS) {
        throw fail("BACKUP_STORE_FULL", "Backup storage quota exceeded");
      }
    }
    return { files, total };
  }

  function load(file) {
    let fd;
    try {
      fd = fs.openSync(path.join(root, file.name), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 ||
          stat.size !== file.size || stat.size > MAX_RECORD_BYTES) {
        throw new Error("Unsafe record");
      }
      const record = JSON.parse(fs.readFileSync(fd, "utf8"));
      validateBinding(record.vaultId, record.path);
      if (record.version !== 1 || `${record.backupId}.json` !== file.name ||
          !ID_PATTERN.test(record.backupId) || typeof record.content !== "string" ||
          typeof record.revision !== "string" || Buffer.byteLength(record.revision) > 1024 ||
          !Number.isSafeInteger(record.createdAt) || record.createdAt < 0 ||
          record.bytes !== Buffer.byteLength(record.content) || record.bytes > MAX_CONTENT_BYTES) {
        throw new Error("Invalid record");
      }
      return record;
    } catch {
      throw fail("BACKUP_STORE_UNSAFE", "Invalid or unsafe backup record");
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }

  return {
    save({ vaultId, path: notePath, content, revision } = {}) {
      validateBinding(vaultId, notePath);
      if (typeof content !== "string" || typeof revision !== "string" || Buffer.byteLength(revision) > 1024) {
        throw fail("INVALID_ARGUMENT", "Backup content and revision must be strings");
      }
      const bytes = Buffer.byteLength(content);
      if (bytes > MAX_CONTENT_BYTES) throw fail("BACKUP_TOO_LARGE", "Backup content exceeds 1 MiB");
      return withLock(() => {
        const { files, total } = inventory();
        let backupId;
        do { backupId = crypto.randomBytes(16).toString("hex"); }
        while (files.some((file) => file.name === `${backupId}.json`));
        const record = { version: 1, backupId, vaultId, path: notePath, revision, createdAt: Date.now(), bytes, content };
        const payload = Buffer.from(JSON.stringify(record));
        if (files.length >= MAX_BACKUPS || total + payload.length > MAX_TOTAL_BYTES) {
          throw fail("BACKUP_STORE_FULL", "Backup storage is full; no snapshots were removed");
        }
        const temp = path.join(root, `.${crypto.randomBytes(16).toString("hex")}.tmp`);
        let fd;
        let created = false;
        try {
          fd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT |
            fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
          created = true;
          fs.writeFileSync(fd, payload);
          fs.fsyncSync(fd);
          fs.closeSync(fd);
          fd = undefined;
          ensureRoot();
          fs.renameSync(temp, path.join(root, `${backupId}.json`));
          created = false;
          return metadata(record);
        } finally {
          if (fd !== undefined) fs.closeSync(fd);
          if (created) fs.unlinkSync(temp);
        }
      });
    },
    list({ vaultId, path: notePath } = {}) {
      validateBinding(vaultId, notePath);
      return withLock(() => inventory().files.map(load)
        .filter((record) => record.vaultId === vaultId && record.path === notePath)
        .map(metadata).sort((a, b) => b.createdAt - a.createdAt || b.backupId.localeCompare(a.backupId)));
    },
    read({ vaultId, path: notePath, backupId } = {}) {
      validateBinding(vaultId, notePath);
      if (typeof backupId !== "string" || !ID_PATTERN.test(backupId)) {
        throw fail("INVALID_ARGUMENT", "Invalid backup ID");
      }
      return withLock(() => {
        const file = inventory().files.find((entry) => entry.name === `${backupId}.json`);
        if (!file) throw fail("BACKUP_NOT_FOUND", "Backup not found");
        const record = load(file);
        if (record.vaultId !== vaultId || record.path !== notePath) {
          throw fail("BACKUP_NOT_FOUND", "Backup not found");
        }
        return { ...metadata(record), content: record.content };
      });
    },
  };
}

module.exports = { createBackupStore, MAX_CONTENT_BYTES, MAX_TOTAL_BYTES, MAX_BACKUPS };
