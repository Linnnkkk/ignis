import { describe, it, expect, beforeAll, afterAll } from "vitest";

describe("current window setFrameZoomLevel", () => {
  let windowShim;
  let webFrame;

  beforeAll(async () => {
    globalThis.window = { innerWidth: 1200, innerHeight: 800 };
    globalThis.document = { body: { style: {} } };
    ({ windowShim } = await import("./window.js"));
    ({ webFrame } = await import("../web-frame.js"));
  });

  afterAll(() => {
    delete globalThis.window;
    delete globalThis.document;
  });

  it("applies the zoom level to the page", () => {
    windowShim._current().setFrameZoomLevel(1);

    expect(webFrame.getZoomLevel()).toBe(1);
  });

  it("clamps the zoom level to Obsidian's range", () => {
    const current = windowShim._current();

    current.setFrameZoomLevel(5);
    expect(webFrame.getZoomLevel()).toBe(3);

    current.setFrameZoomLevel(-4);
    expect(webFrame.getZoomLevel()).toBe(-2.5);
  });
});
