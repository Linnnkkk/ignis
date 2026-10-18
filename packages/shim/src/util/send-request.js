// Sends a requestUrl-style request. Either through server proxy, or directly for same-origin and direct-fetch hosts.

import { isSameOrigin, isDirectFetchHost } from "./url.js";
import { proxyFetch } from "./proxy.js";

function hasContentTypeHeader(headers) {
  return Object.keys(headers).some(
    (key) => key.toLowerCase() === "content-type",
  );
}

async function fetchDirect({ url, method, headers, body }) {
  const nativeFetch = window.__originalFetch || fetch;
  const res = await nativeFetch(url, { method, headers, body });

  return {
    status: res.status,
    headers: Object.fromEntries(res.headers),
    body: await res.arrayBuffer(),
  };
}

export async function sendRequest({ url, method, headers, body, contentType }) {
  const requestHeaders = { ...headers };

  if (contentType && !hasContentTypeHeader(requestHeaders)) {
    requestHeaders["Content-Type"] = contentType;
  }

  const request = {
    url,
    method: method || "GET",
    headers: requestHeaders,
    body,
  };

  if (isSameOrigin(url) || isDirectFetchHost(url)) {
    return fetchDirect(request);
  }

  return proxyFetch(request);
}
