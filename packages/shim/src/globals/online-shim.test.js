import { describe, it, expect, vi } from "vitest";
import { installOnlineShim } from "./web-apis.js";

describe("navigator.onLine shim", () => {
  it("reports online so Obsidian's plugin update check issues a request", () => {
    // Obsidian bails out before fetching when navigator.onLine is false. Inside the
    // local shell's 127.0.0.1 WebView that value can be false, which surfaced as a
    // bogus "no internet" error for plugin updates.
    const fakeNavigator = {};
    vi.stubGlobal("navigator", fakeNavigator);
    installOnlineShim();
    expect(fakeNavigator.onLine).toBe(true);
    vi.unstubAllGlobals();
  });
});
