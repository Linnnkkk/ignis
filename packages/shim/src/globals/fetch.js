import { isSameOrigin, isDirectFetchHost } from "../util/url.js";
import { proxyFetch } from "../util/proxy.js";
import { desktopHeaders } from "../util/desktop-identity.js";

function hasHeader(headers, name) {
  return Object.keys(headers).some(
    (key) => key.toLowerCase() === name.toLowerCase(),
  );
}

export function installFetchShim() {
  const originalFetch = window.fetch.bind(window);
  window.__originalFetch = originalFetch;

  // ★ 排障：原生 fetch 的失败也要现形（NetworkError 可能来自绕过包装的内部调用）
  window.__probeNativeFetch = async function (input, init) {
    try {
      const r = await originalFetch(input, init);
      if (!r.ok) {
        console.error("[shim:fetch] native !ok " + r.status + " " + String(typeof input === "string" ? input : (input && input.url) || input));
      }
      return r;
    } catch (e) {
      console.error("[shim:fetch] native THREW " + String(typeof input === "string" ? input : (input && input.url) || input) + " : " + (e && e.message));
      throw e;
    }
  };

  window.fetch = async function (input, init) {
    let url;

    if (typeof input === "string") {
      url = input;
    } else if (input instanceof URL) {
      url = input.href;
    } else if (input instanceof Request) {
      url = input.url;
    } else {
      url = String(input);
    }
    // ★ 排障：所有 fetch 调用无条件现形（定位那 3 个 NetworkError 的真身）
    console.log("[shim:fetch] CALL " + url.slice(0, 150));

    // Obsidian 1.13+ 请求 app://obsidian.md/...（Electron 自定义协议读自带资源）。
    // 不让它们走跨域代理（server 代理只认 http/https 会 400 → NetworkError 断启动链）。
    // 直接改写成同源路径：app://obsidian.md/xxx → /xxx（server 静态目录本来就伺服 obsidian-assets）。
    if (url.startsWith("app://obsidian.md/")) {
      const rel = url.slice("app://obsidian.md".length).split("?")[0];
      console.log("[shim:fetch] app:// rewritten to same-origin:", rel);
      return originalFetch(rel, init);
    }

    if (isSameOrigin(url) || isDirectFetchHost(url)) {
      // ★ 排障：同源透传也打结果——NetworkError 移位到这里了，必须看到哪个 URL 炸
      return originalFetch(input, init).then(
        (r) => {
          if (!r.ok) {
            console.error("[shim:fetch] SAME-ORIGIN !ok " + r.status + " " + url.slice(0, 120));
          }
          return r;
        },
        (e) => {
          console.error("[shim:fetch] SAME-ORIGIN THREW " + url.slice(0, 120) + " : " + (e && e.message));
          throw e;
        }
      );
    }

    // Cross-origin. route through server proxy
    const method = (
      init?.method || (input instanceof Request ? input.method : "GET")
    ).toUpperCase();
    const headers = {};

    if (init?.headers) {
      const h =
        init.headers instanceof Headers
          ? init.headers
          : new Headers(init.headers);
      h.forEach((val, key) => {
        headers[key] = val;
      });
    } else if (input instanceof Request) {
      input.headers.forEach((val, key) => {
        headers[key] = val;
      });
    }

    for (const [name, value] of Object.entries(desktopHeaders())) {
      if (!hasHeader(headers, name)) {
        headers[name] = value;
      }
    }

    let body = null;

    if (init?.body && method !== "GET" && method !== "HEAD") {
      if (typeof init.body === "string") {
        body = init.body;
      } else if (
        init.body instanceof ArrayBuffer ||
        init.body instanceof Uint8Array
      ) {
        body = init.body;
      } else if (typeof init.body === "object") {
        body = JSON.stringify(init.body);
      } else {
        body = String(init.body);
      }
    }

    console.log("[shim:fetch] Proxying cross-origin:", method, url);

    let result;

    try {
      result = await proxyFetch({ url, method, headers, body });
    } catch (e) {
      throw new TypeError(e.message || "Failed to fetch");
    }

    return new Response(result.body, {
      status: result.status,
      headers: result.headers,
    });
  };
}
