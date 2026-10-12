import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { transport } from "./transport.js";

let fetchMock;

beforeEach(() => {
  fetchMock = vi.fn(async () => ({
    ok: true,
    json: async () => ({}),
    text: async () => "",
    arrayBuffer: async () => new ArrayBuffer(0),
  }));
  globalThis.fetch = fetchMock;
  globalThis.window = {
    location: { origin: "http://localhost" },
    __currentVaultId: "v",
  };
});

afterEach(() => {
  delete globalThis.fetch;
  delete globalThis.window;
});

function lastInit() {
  return fetchMock.mock.calls.at(-1)[1];
}

describe("large binary uploads", () => {
  it("sends bounded chunks and waits for atomic finish", async () => {
    fetchMock.mockImplementation(async () => ({ ok: true, json: async () => ({ id: "upload-test", ok: true }) }));
    await transport.writeFile("video.mp4", new Uint8Array(5 * 1024 * 1024 + 7));
    const bodies = fetchMock.mock.calls.map((call) => JSON.parse(call[1].body));
    expect(bodies[0]).toMatchObject({ action: "start", size: 5 * 1024 * 1024 + 7, vault: "v" });
    const chunks = bodies.filter((body) => body.action === "chunk");
    expect(chunks).toHaveLength(6);
    expect(chunks.map((body) => body.offset)).toEqual([0, 1048576, 2097152, 3145728, 4194304, 5242880]);
    expect(chunks.every((body) => body.content.length <= Math.ceil(1048576 / 3) * 4)).toBe(true);
    expect(bodies.at(-1).action).toBe("finish");
  });

  it("cancels a failed upload and preserves the original error", async () => {
    let count = 0;
    fetchMock.mockImplementation(async () => {
      if (++count === 2) throw new Error("network interrupted");
      return { ok: true, json: async () => ({ id: "upload-test" }) };
    });
    await expect(transport.writeFile("video.mp4", new Uint8Array(5 * 1024 * 1024))).rejects.toThrow("network interrupted");
    expect(JSON.parse(lastInit().body).action).toBe("cancel");
  });
});

describe("transport keepalive gating", () => {
  it("sets keepalive on a small write", async () => {
    await transport.writeFile("a.md", "hello", "utf-8");

    expect(lastInit().keepalive).toBe(true);
  });

  it("omits keepalive when the body exceeds the 64KB cap", async () => {
    await transport.writeFile("a.md", "x".repeat(70 * 1024), "utf-8");

    expect(lastInit().keepalive).toBeFalsy();
  });

  it("counts base64 inflation against the cap for binary writes", async () => {
    // 60KB of bytes inflates to ~80KB of base64, over the cap.
    await transport.writeFile("a.bin", new Uint8Array(60 * 1024));

    expect(lastInit().keepalive).toBeFalsy();
  });

  it("sets keepalive on a bodyless delete", async () => {
    await transport.unlink("a.md");

    expect(lastInit().keepalive).toBe(true);
  });

  it("does not set keepalive on a read", async () => {
    await transport.readFile("a.md", "utf8");

    expect(lastInit().keepalive).toBeUndefined();
  });
});
