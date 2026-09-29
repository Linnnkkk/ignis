import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

let checkForUpdate;

function release(tag) {
  return {
    ok: true,
    json: async () => ({
      tag_name: tag,
      html_url: `https://example.com/${tag}`,
    }),
  };
}

beforeEach(async () => {
  vi.resetModules();
  ({ checkForUpdate } = await import("./update-check.js"));
});

afterEach(() => {
  delete globalThis.fetch;
});

describe("checkForUpdate", () => {
  it("returns a newer release", async () => {
    globalThis.fetch = vi.fn(async () => release("v0.9.0"));

    expect(await checkForUpdate("0.8.12+abc123")).toEqual({
      version: "0.9.0",
      url: "https://example.com/v0.9.0",
    });
  });

  it("is null when the running version is the latest release", async () => {
    globalThis.fetch = vi.fn(async () => release("v0.8.12"));

    expect(await checkForUpdate("0.8.12+abc123")).toBe(null);
  });

  it("is null when the check fails", async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: false }));

    expect(await checkForUpdate("0.8.12")).toBe(null);
  });

  it("checks once per page session", async () => {
    globalThis.fetch = vi.fn(async () => release("v0.9.0"));

    await checkForUpdate("0.8.12");
    await checkForUpdate("0.8.12");

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });
});
