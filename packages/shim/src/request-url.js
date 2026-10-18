// Override window.requestUrl to proxy external requests through our server, bypassing CORS.
// Obsidian sets window.requestUrl in app.js, so we override it after app.js loads.

import { sendRequest } from "./util/send-request.js";

async function proxyRequestUrl(request) {
  if (typeof request === "string") {
    request = { url: request };
  }

  const result = await sendRequest(request);

  return makeResponse(request, result.status, result.headers, result.body);
}

function makeResponse(request, status, headers, arrayBuf) {
  const text = new TextDecoder().decode(arrayBuf);
  let json;

  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }

  return { status, headers, arrayBuffer: arrayBuf, text, json };
}

export function installRequestUrlShim() {
  // Obsidian sets window.requestUrl in app.js. We override it once the page loads.
  // Use a getter so it intercepts even if app.js sets it later.
  Object.defineProperty(window, "requestUrl", {
    get() {
      return proxyRequestUrl;
    },
    // Swallow Obsidian's later assignment so the shim keeps serving its own requestUrl.
    set() {},
    configurable: true,
  });
}
