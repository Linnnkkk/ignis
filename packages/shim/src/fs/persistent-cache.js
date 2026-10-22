// 持久化文件缓存（IndexedDB），用于远程模式下加速插件等大文件的重复读取。
// 动机：Obsidian 读插件 main.js / styles.css 走的是文件接口，不是浏览器 <script>，
// 所以每次打开远程库都要把插件正文重新下载一遍，进入明显变慢。
// 做法：按路径存 {etag, body}；下次读取先带 If-None-Match，服务器回 304 就直接用本地正文。
// 只缓存明确"可重复读取"的路径（插件/主题），笔记正文不进这个缓存。

const DB_NAME = "ignis-file-cache";
const STORE = "files";
const DB_VERSION = 1;

let dbPromise = null;

function openDb() {
  if (dbPromise) {
    return dbPromise;
  }

  dbPromise = new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION);

      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: "path" });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });

  return dbPromise;
}

function withStore(mode, run) {
  return openDb().then(
    (db) =>
      new Promise((resolve) => {
        if (!db) {
          resolve(null);
          return;
        }
        try {
          const tx = db.transaction(STORE, mode);
          const store = tx.objectStore(STORE);
          const request = run(store);
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => resolve(null);
        } catch {
          resolve(null);
        }
      }),
  );
}

// Only installed executable/style assets; never plugin data, manifests or notes.
export function isCacheablePath(path) {
  const p = path.replace(/^\/+/, "");
  if (p.split("/").some((part) => part === "." || part === "..")) return false;

  return /^\.obsidian\/plugins\/[^/]+\/(main\.js|styles\.css)$/.test(p) ||
    /^\.obsidian\/themes\/[^/]+\/[^/]+\.css$/.test(p) ||
    /^\.obsidian\/snippets\/[^/]+\.css$/.test(p);
}

function entryKey(path, vaultId) {
  // Keep legacy on-demand keys separate: they did not identify the vault.
  return vaultId === undefined ? path : JSON.stringify([vaultId, path.replace(/^\/+/, "")]);
}

export async function getCachedEntry(path, vaultId) {
  if (!isCacheablePath(path)) return null;
  const row = await withStore("readonly", (store) => store.get(entryKey(path, vaultId)));

  if (!row || typeof row.body !== "string") {
    return null;
  }

  return { etag: row.etag || "", body: row.body };
}

export async function putCachedEntry(path, etag, body, vaultId) {
  if (!isCacheablePath(path) || !etag || typeof body !== "string") {
    return;
  }

  // 单个文件上限 8MB，避免把超大资源塞进数据库
  if (body.length > 8 * 1024 * 1024) {
    return;
  }

  await withStore("readwrite", (store) =>
    store.put({ path: entryKey(path, vaultId), etag, body, savedAt: Date.now() }),
  );
}

export async function dropCachedEntry(path, vaultId) {
  await withStore("readwrite", (store) => store.delete(entryKey(path, vaultId)));
}

// Every reuse requires the server's conditional-read verdict, never a TTL or tree snapshot.
// A cold miss also uses readFile: batch-read provides no per-file validators to persist safely.
export async function readCachedAsset(vaultId, path) {
  if (!isCacheablePath(path)) throw new Error("Not a cacheable asset");
  const cached = await getCachedEntry(path, vaultId);
  const query = new URLSearchParams({ vault: vaultId, path, encoding: "utf8" });
  const res = await fetch("/api/fs/readFile?" + query, {
    headers: cached?.etag ? { "If-None-Match": cached.etag } : {},
  });

  if (res.status === 304) {
    if (!cached?.etag) throw new Error("Unexpected asset 304 without cached validator");
    return cached.body;
  }
  if (!res.ok) throw new Error("asset read failed: " + res.status);

  const body = await res.text();
  const etag = res.headers?.get("ETag") || "";
  if (etag) {
    await putCachedEntry(path, etag, body, vaultId);
  } else {
    // Old servers/pending writes may omit validators. Use their fresh body, never stale IDB.
    await dropCachedEntry(path, vaultId);
  }
  return body;
}
