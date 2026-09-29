import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const disk = new Map();

vi.mock("../fs/index.js", () => ({
  fsShim: {
    readFileSync(path) {
      if (!disk.has(path)) {
        throw new Error("ENOENT");
      }

      return disk.get(path);
    },
  },
}));

const { forceConfigValue } = await import("./forced-config.js");
const { applyReadTransform, applyWriteTransform, _reset } =
  await import("../fs/transforms.js");

const PATH = ".obsidian/app.json";

function withVault() {
  const saved = new Map();
  const vault = {
    getConfig(key) {
      return saved.has(key) ? saved.get(key) : key === "popout";
    },
    setConfig(key, value) {
      saved.set(key, value);
    },
  };

  globalThis.window = { app: { vault } };

  return { vault, saved };
}

beforeEach(() => {
  _reset();
  disk.clear();
});

afterEach(() => {
  delete globalThis.window;
});

describe("forceConfigValue", () => {
  it("reads the forced value, inserting the key when the file lacks it", () => {
    withVault();
    forceConfigValue(PATH, "popout", false);

    expect(JSON.parse(applyReadTransform(PATH, '{"a":1}'))).toEqual({
      a: 1,
      popout: false,
    });
  });

  it("writes back the value that was on disk", () => {
    disk.set(PATH, '{"popout":true}');
    withVault();
    forceConfigValue(PATH, "popout", false);

    expect(
      JSON.parse(applyWriteTransform(PATH, '{"a":1,"popout":false}')),
    ).toEqual({ a: 1, popout: true });
  });

  it("writes the key out entirely when it was absent on disk", () => {
    disk.set(PATH, '{"a":1}');
    withVault();
    forceConfigValue(PATH, "popout", false);

    expect(
      JSON.parse(applyWriteTransform(PATH, '{"a":1,"popout":false}')),
    ).toEqual({ a: 1 });
  });

  it("reads the forced value when the loaded config lacks the key", () => {
    const { vault } = withVault();
    forceConfigValue(PATH, "popout", false);

    expect(vault.getConfig("popout")).toBe(false);
    expect(vault.getConfig("other")).toBe(false);
  });

  it("coerces setConfig for the key and passes other keys through", () => {
    const { vault, saved } = withVault();
    forceConfigValue(PATH, "popout", false);

    vault.setConfig("popout", true);
    vault.setConfig("other", true);

    expect(saved.get("popout")).toBe(false);
    expect(saved.get("other")).toBe(true);
  });

  it("reports a refused write only when the value differs from the forced one", () => {
    const { vault } = withVault();
    const onRefused = vi.fn();
    forceConfigValue(PATH, "popout", false, onRefused);

    vault.setConfig("popout", false);
    expect(onRefused).not.toHaveBeenCalled();

    vault.setConfig("popout", true);
    expect(onRefused).toHaveBeenCalledTimes(1);
  });
});
