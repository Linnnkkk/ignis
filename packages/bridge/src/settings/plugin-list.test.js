import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

let pluginList;
let handlers;

function respond(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function discoveredPlugins() {
  return [
    {
      id: "headless-sync",
      name: "Headless Sync",
      bundledPluginId: "ignis-headless-sync",
      enabledVaults: ["other"],
    },
    { id: "server-only", name: "Server only", enabledVaults: [] },
  ];
}

function findPlugin(id) {
  return pluginList.get().find((p) => p.id === id);
}

beforeEach(async () => {
  vi.resetModules();
  handlers = new Map();
  globalThis.window = {
    __ignis: {
      ws: {
        subscribe: (type, handler) => {
          handlers.set(type, handler);
          return () => {};
        },
      },
    },
  };
  globalThis.fetch = vi.fn(async () => respond(200, discoveredPlugins()));
  pluginList = await import("./plugin-list.js");
});

afterEach(() => {
  vi.restoreAllMocks();
  delete globalThis.window;
  delete globalThis.fetch;
});

describe("plugin-list", () => {
  it("seeds from GET /api/plugins", async () => {
    expect(pluginList.get()).toBe(null);

    expect(await pluginList.refresh()).toBe(true);
    expect(globalThis.fetch).toHaveBeenCalledWith("/api/plugins");
    expect(pluginList.get()).toEqual(discoveredPlugins());
  });

  it("keeps the same list when a refresh returns the same plugins", async () => {
    await pluginList.refresh();
    const seeded = pluginList.get();

    expect(await pluginList.refresh()).toBe(false);
    expect(pluginList.get()).toBe(seeded);
  });

  it("marks a failed seed and reports the change once", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    globalThis.fetch = vi.fn(async () => respond(500, {}));

    expect(await pluginList.refresh()).toBe(true);
    expect(pluginList.loadFailed()).toBe(true);
    expect(pluginList.get()).toBe(null);
    expect(await pluginList.refresh()).toBe(false);
  });

  it("patches a plugin's vaults after a toggle", async () => {
    await pluginList.refresh();

    pluginList.setEnabled("headless-sync", "vault-a", true);
    expect(findPlugin("headless-sync").enabledVaults).toEqual([
      "other",
      "vault-a",
    ]);

    pluginList.setEnabled("headless-sync", "vault-a", true);
    expect(findPlugin("headless-sync").enabledVaults).toEqual([
      "other",
      "vault-a",
    ]);

    pluginList.setEnabled("headless-sync", "vault-a", false);
    expect(findPlugin("headless-sync").enabledVaults).toEqual(["other"]);
  });

  it("patches a plugin's vaults from enable and disable broadcasts", async () => {
    await pluginList.refresh();
    pluginList.watchPluginToggles();

    handlers.get("virtual-plugin-enable")({
      type: "virtual-plugin-enable",
      vault: "vault-a",
      entry: { id: "ignis-headless-sync" },
    });
    expect(findPlugin("headless-sync").enabledVaults).toEqual([
      "other",
      "vault-a",
    ]);

    handlers.get("virtual-plugin-disable")({
      type: "virtual-plugin-disable",
      vault: "vault-a",
      id: "ignis-headless-sync",
    });
    expect(findPlugin("headless-sync").enabledVaults).toEqual(["other"]);
    expect(findPlugin("server-only").enabledVaults).toEqual([]);
  });

  it("ignores broadcasts before the seed", () => {
    pluginList.watchPluginToggles();

    handlers.get("virtual-plugin-enable")({
      vault: "vault-a",
      entry: { id: "ignis-headless-sync" },
    });

    expect(pluginList.get()).toBe(null);
  });
});
