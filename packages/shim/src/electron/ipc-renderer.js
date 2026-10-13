import { showVaultManager } from "../ui-registry.js";
import { vaultService } from "@ignis/services";
import { proxyFetch } from "../util/proxy.js";

const listeners = new Map();

// Obsidian >=1.13 expects different payload shapes for the `terms` and
// `policy` startup channels (an exact license string / a plain object),
// while 1.12.x only checks for truthy values and was verified against an
// object / null. Probe the injected version on every call so both release
// lines keep working; unknown versions get the 1.13 treatment (the current
// upstream release).
function isObsidian113Plus() {
  const m = /^(\d+)\.(\d+)/.exec(String(window.__obsidianVersion || ""));
  if (!m) return true;
  return Number(m[1]) > 1 || Number(m[2]) >= 13;
}

// Obsidian 1.13.x freezes this payload at startup and then consults each
// capability as a hard gate: `PluginManager.enablePlugin` starts with
// `if (!Db(Ab.plugins, id)) return false` where Db accepts `true` or an array
// of ids. An empty object therefore reads as `Ab.plugins === undefined` and
// silently blocks *every* community plugin ("plugins can't be recognized or
// loaded"). The desktop main process sends this all-true object unless a
// managed policy.json restricts the install, so mirror that default.
const DEFAULT_POLICY = {
  plugins: true,
  themes: true,
  snippets: true,
  sync: true,
  publish: true,
  webViewer: true,
  devTools: true,
  insider: true,
};

const syncHandlers = {
  vault: () => window.__vaultConfig || { id: "default-vault", path: "/" },
  version: () => window.__obsidianVersion || "0.0.0",
  "is-dev": () => false,

  // Official terms extraction is injected into window.__obsidianTerms by index-html.js.
  // Keep the verified 1.12.x payload shape while using the exact extracted
  // 1.13.x license string from the user's own Obsidian package.
  terms: () =>
    isObsidian113Plus()
      ? window.__obsidianTerms ||
        "I understand and agree that I am not allowed to distribute the Obsidian application, in any form, without explicit approval from the Obsidian team. I also understand that Obsidian is a registered trademark, and I cannot use it without explicit permission granted by the Obsidian team."
      : { accepted: true },
  // 1.13.x freezes this for per-capability gates (see DEFAULT_POLICY); an
  // empty object blocks all community plugins. 1.12.x has no policy lookups at
  // all and was verified against null, so it keeps that shape.
  policy: () =>
    isObsidian113Plus() ? Object.assign({}, DEFAULT_POLICY) : null,
  // Unload guards: never block the tab from closing.
  "is-closing": () => false,
  "is-quitting": () => false,

  "file-url": () =>
    "/vault-files/" + encodeURIComponent(window.__currentVaultId || "") + "/",

  "disable-update": () => true,
  update: () => "",
  "disable-gpu": () => false,
  frame: () => null,
  "set-icon": () => null,
  "get-icon": () => null,

  // Obsidian 1.13+ 新增的配置查询（Electron webContents 级策略/服务条款状态）。
  // 真实 Electron 里由主进程返回策略对象；这里返回 null/默认值 = "无限制"，
  // 渲染器拿到后按默认路径走（与 frame/sandbox 的处理同款）。
  // 缺失时渲染器启动序列中断（1.13.7 实测：sendSync 卡死后 window.close()）。

  relaunch: () => {
    window.location.reload();
    return null;
  },

  starter: () => {
    showVaultManager();
    return null;
  },

  help: () => {
    window.open("https://help.obsidian.md/", "_blank");
    return null;
  },

  sandbox: () => null,

  // 1.13.x settings surface: ad-blocker lists are absent in the web version.
  "adblock-lists": () => [],
  "adblock-frequency": () => 0,

  // Sandbox-vault detection: this build never runs inside the sandbox.
  "get-sandbox-vault-path": () => "/",

  // CLI / internal-build / language channels have no desktop equivalent.
  cli: () => null,
  "insider-build": () => false,
  "set-language": () => null,

  "copy-asar": () => false,
  "check-update": () => null,
  "latest-public-version": () => window.__obsidianVersion || null,

  "vault-list": () => {
    const result = {};

    for (const v of window.__vaultList || []) {
      result[v.id] = {
        path: "/" + v.id,
        ts: Date.now(),
        open: v.id === vaultService.getCurrentVaultId(),
      };
    }

    return result;
  },

  "vault-open": (vaultPath, newWindow) => {
    const id = (vaultPath || "").replace(/^\/+/, "");
    const vault = (window.__vaultList || []).find((v) => v.id === id);

    if (!vault && id) {
      if (!vaultService.createVaultSync(id)) {
        return "Failed to create vault";
      }
    }

    vaultService.openVault(id);

    return true;
  },

  "vault-remove": (vaultPath) => {
    const id = (vaultPath || "").replace(/^\/+/, "");

    return vaultService.deleteVaultSync(id);
  },

  "vault-move": (oldPath, newPath) => {
    return "Moving vaults is not supported in the web version";
  },

  "vault-message": () => null,
  "get-default-vault-path": () => "/My Vault",
  "get-documents-path": () => "/",
  "desktop-dir": () => "/desktop",
  "documents-dir": () => "/documents",
  resources: () => "",
};

async function handleRequestUrl(requestId, request) {
  try {
    const result = await proxyFetch({
      url: request.url,
      method: request.method,
      headers: request.headers,
      body: request.body,
      contentType: request.contentType,
    });

    // Electron's e.reply(requestId, data) sends on the requestId channel
    ipcRenderer._emit(requestId, {
      status: result.status,
      headers: result.headers,
      body: result.body,
    });
  } catch (e) {
    ipcRenderer._emit(requestId, {
      error: e.message,
    });
  }
}

export const ipcRenderer = {
  send(channel, ...args) {
    console.log("[shim:ipcRenderer] send:", channel, args);

    if (channel === "context-menu") {
      queueMicrotask(() =>
        ipcRenderer._emit("context-menu", {
          webContentsId: 1,
          editFlags: { canCut: true, canCopy: true, canPaste: true },
        }),
      );
      return;
    }

    if (channel === "request-url") {
      const [requestId, request] = args;
      handleRequestUrl(requestId, request);
      return;
    }

    if (channel === "print-to-pdf") {
      const iframe = window.__popupIframe;

      if (iframe) {
        setTimeout(() => {
          iframe.contentWindow.print();
          setTimeout(() => {
            iframe.contentWindow.close();
            ipcRenderer._emit("print-to-pdf", { success: true });
          }, 500);
        }, 200);
      } else {
        window.print();

        queueMicrotask(() => {
          ipcRenderer._emit("print-to-pdf", { success: true });
        });
      }
      return;
    }
  },

  sendSync(channel, ...args) {
    console.log("[shim:ipcRenderer] sendSync:", channel, args);

    if (syncHandlers[channel]) {
      return syncHandlers[channel](...args);
    }

    console.warn("[shim:ipcRenderer] Unhandled sendSync channel:", channel);
    return null;
  },

  on(channel, listener) {
    if (!listeners.has(channel)) {
      listeners.set(channel, []);
    }

    listeners.get(channel).push(listener);

    return ipcRenderer;
  },

  once(channel, listener) {
    const wrapped = (...args) => {
      ipcRenderer.removeListener(channel, wrapped);
      listener(...args);
    };

    return ipcRenderer.on(channel, wrapped);
  },

  removeListener(channel, listener) {
    const arr = listeners.get(channel);
    if (arr) {
      const idx = arr.indexOf(listener);

      if (idx >= 0) {
        arr.splice(idx, 1);
      }
    }

    return ipcRenderer;
  },

  removeAllListeners(channel) {
    if (channel) {
      listeners.delete(channel);
    } else {
      listeners.clear();
    }

    return ipcRenderer;
  },

  _emit(channel, ...args) {
    const arr = listeners.get(channel);

    if (arr) {
      for (const fn of arr) {
        fn({}, ...args);
      }
    }
  },
};
