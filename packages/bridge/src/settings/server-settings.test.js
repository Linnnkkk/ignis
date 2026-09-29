import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("obsidian", () => ({ Notice: class {} }));

let serverSettings;

function respond(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

beforeEach(async () => {
  vi.resetModules();
  serverSettings = await import("./server-settings.js");
});

afterEach(() => {
  delete globalThis.fetch;
});

describe("server-settings", () => {
  it("seeds from GET /api/settings", async () => {
    globalThis.fetch = vi.fn(async () => respond(200, { writeCoalesceMs: 0 }));

    expect(await serverSettings.refresh()).toBe(true);
    expect(globalThis.fetch).toHaveBeenCalledWith("/api/settings");
    expect(serverSettings.get()).toEqual({ writeCoalesceMs: 0 });
  });

  it("keeps the same object when a refresh returns the same settings", async () => {
    globalThis.fetch = vi.fn(async () => respond(200, { writeCoalesceMs: 0 }));
    await serverSettings.refresh();
    const seeded = serverSettings.get();

    expect(await serverSettings.refresh()).toBe(false);
    expect(serverSettings.get()).toBe(seeded);
  });

  it("replaces the settings when a refresh returns different settings", async () => {
    globalThis.fetch = vi.fn(async () => respond(200, { writeCoalesceMs: 0 }));
    await serverSettings.refresh();
    globalThis.fetch = vi.fn(async () => respond(200, { writeCoalesceMs: 5 }));

    expect(await serverSettings.refresh()).toBe(true);
    expect(serverSettings.get()).toEqual({ writeCoalesceMs: 5 });
  });

  it("marks a failed seed and reports the change once", async () => {
    globalThis.fetch = vi.fn(async () => respond(500, {}));

    expect(await serverSettings.refresh()).toBe(true);
    expect(serverSettings.loadFailed()).toBe(true);
    expect(serverSettings.get()).toBe(null);
    expect(await serverSettings.refresh()).toBe(false);
  });

  it("keeps the previous settings when a later refresh fails", async () => {
    globalThis.fetch = vi.fn(async () => respond(200, { writeCoalesceMs: 0 }));
    await serverSettings.refresh();
    globalThis.fetch = vi.fn(async () => {
      throw new Error("offline");
    });

    await serverSettings.refresh();

    expect(serverSettings.get()).toEqual({ writeCoalesceMs: 0 });
  });

  it("replaces the settings with the save response", async () => {
    globalThis.fetch = vi.fn(async () => respond(200, { writeCoalesceMs: 0 }));
    await serverSettings.refresh();
    globalThis.fetch = vi.fn(async () =>
      respond(200, { writeCoalesceMs: 250, maxBodyBytes: 1024 }),
    );

    await serverSettings.save({ writeCoalesceMs: 250 });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "/api/settings",
      expect.objectContaining({ method: "POST" }),
    );
    expect(serverSettings.get()).toEqual({
      writeCoalesceMs: 250,
      maxBodyBytes: 1024,
    });
  });

  it("keeps the settings when save fails", async () => {
    globalThis.fetch = vi.fn(async () => respond(200, { writeCoalesceMs: 0 }));
    await serverSettings.refresh();
    globalThis.fetch = vi.fn(async () => respond(400, { error: "bad value" }));

    expect(await serverSettings.save({ writeCoalesceMs: -1 })).toBe(false);
    expect(serverSettings.get()).toEqual({ writeCoalesceMs: 0 });
  });
});
