import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const CONFIG_ID = require.resolve("./config.js");

// Symlink creation needs privilege or Developer Mode on Windows; skip those cases where it fails.
let canSymlink = false;
try {
  const probe = fs.mkdtempSync(path.join(os.tmpdir(), "ignis-symlink-probe-"));
  fs.symlinkSync(probe, path.join(probe, "l"), "dir");
  canSymlink = true;
  fs.rmSync(probe, { recursive: true, force: true });
} catch {
  canSymlink = false;
}

let root;
let target;
let dataRoot;

function loadConfig() {
  process.env.VAULT_ROOT = root;
  process.env.DATA_ROOT = dataRoot;
  delete process.env.AUTO_CREATE_DEFAULT;
  delete require.cache[CONFIG_ID];
  return require("./config.js");
}

function loadVaults() {
  return loadConfig().vaults;
}

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ignis-vaultroot-"));
  target = fs.mkdtempSync(path.join(os.tmpdir(), "ignis-linktarget-"));
  dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ignis-dataroot-"));

  fs.mkdirSync(path.join(root, "realvault"));
  fs.mkdirSync(path.join(root, ".hidden"));
  fs.writeFileSync(path.join(root, "notavault.md"), "x");

  if (canSymlink) {
    fs.symlinkSync(target, path.join(root, "linkvault"), "dir");
    fs.symlinkSync(
      path.join(target, "nope"),
      path.join(root, "dangling"),
      "dir",
    );
  }
});

afterAll(() => {
  for (const d of [root, target, dataRoot]) {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

describe("discoverVaults", () => {
  it("discovers a real directory and skips dotfiles and regular files", () => {
    const names = Object.keys(loadVaults());
    expect(names).toContain("realvault");
    expect(names).not.toContain(".hidden");
    expect(names).not.toContain("notavault.md");
  });

  it.skipIf(!canSymlink)("discovers a symlinked directory as a vault", () => {
    expect(Object.keys(loadVaults())).toContain("linkvault");
  });

  it.skipIf(!canSymlink)("skips a dangling symlink", () => {
    expect(Object.keys(loadVaults())).not.toContain("dangling");
  });
});

describe("getVaultPath", () => {
  it("resolves a discovered vault and rejects prototype keys", () => {
    const config = loadConfig();

    expect(config.getVaultPath("realvault")).toBe(path.join(root, "realvault"));
    expect(config.getVaultPath("constructor")).toBe(null);
    expect(config.getVaultPath("hasOwnProperty")).toBe(null);
    expect(config.getVaultPath("__proto__")).toBe(null);
  });
});

describe("getVaultPathOrRescan", () => {
  it("finds a vault folder added after startup by rescanning once", () => {
    const config = loadConfig();

    expect(config.getVaultPath("added")).toBe(null);

    fs.mkdirSync(path.join(root, "added"));

    expect(config.getVaultPathOrRescan("added", 10_000)).toBe(
      path.join(root, "added"),
    );
    expect(config.getVaultPath("added")).toBe(path.join(root, "added"));
  });

  it("does not rescan twice inside the throttle window", () => {
    const config = loadConfig();

    expect(config.getVaultPathOrRescan("missing", 20_000)).toBe(null);

    fs.mkdirSync(path.join(root, "throttled"));

    expect(config.getVaultPathOrRescan("throttled", 20_500)).toBe(null);
    expect(config.getVaultPathOrRescan("throttled", 21_000)).toBe(
      path.join(root, "throttled"),
    );
  });

  it("answers a known vault without rescanning", () => {
    const config = loadConfig();

    expect(config.getVaultPathOrRescan("realvault", 30_000)).toBe(
      path.join(root, "realvault"),
    );
  });
});

describe("remote vault isolation", () => {
  const configFile = () => path.join(dataRoot, "remote-vaults.json");
  const writeRemote = (id, url = "https://example.com/dav") =>
    fs.writeFileSync(configFile(), JSON.stringify({ vaults: [{ id, url }] }));
  const registry = require("./webdav/registry.js");

  afterEach(() => {
    fs.rmSync(configFile(), { force: true });
  });

  it("keeps a same-named local vault untouched and rejects the remote", () => {
    const marker = path.join(root, "realvault", "note.md");
    fs.writeFileSync(marker, "local content");
    writeRemote("realvault");
    const config = loadConfig();
    expect(config.getVaultPath("realvault")).toBe(path.join(root, "realvault"));
    expect(registry.isRemoteVault("realvault")).toBe(false);
    expect(fs.readFileSync(marker, "utf8")).toBe("local content");
  });

  it("isolates placeholders and does not discover them after configuration fails or disappears", () => {
    writeRemote("remote-isolated");
    let config = loadConfig();
    const dir = config.getVaultPath("remote-isolated");
    expect(dir).toBe(path.join(root, ".ignis-remote-vaults", "remote-isolated"));
    expect(registry.backendForPath(path.join(dir, "note.md"))?.vaultId).toBe("remote-isolated");
    fs.writeFileSync(configFile(), "{invalid");
    config = loadConfig();
    expect(registry.error()).toBeTruthy();
    expect(config.getVaultPath("remote-isolated")).toBeNull();
    expect(registry.backendForPath(dir)).toBeNull();
    fs.rmSync(configFile());
    expect(loadConfig().getVaultPath("remote-isolated")).toBeNull();
    expect(fs.existsSync(dir)).toBe(true);
  });

  it("unmounts a remote if a local directory appears before rescan", () => {
    writeRemote("later-local");
    const config = loadConfig();
    expect(registry.isRemoteVault("later-local")).toBe(true);
    fs.mkdirSync(path.join(root, "later-local"));
    config.refreshVaults();
    expect(config.getVaultPath("later-local")).toBe(path.join(root, "later-local"));
    expect(registry.isRemoteVault("later-local")).toBe(false);
  });

  it.skipIf(!canSymlink)("rejects a symlinked placeholder without using its target", () => {
    const mountRoot = path.join(root, ".ignis-remote-vaults");
    fs.mkdirSync(mountRoot, { recursive: true });
    fs.symlinkSync(target, path.join(mountRoot, "linked-remote"), "dir");
    writeRemote("linked-remote");
    expect(loadConfig().getVaultPath("linked-remote")).toBeNull();
    expect(registry.isRemoteVault("linked-remote")).toBe(false);
  });

  it("does not expose a placeholder for an invalid URL", () => {
    writeRemote("bad-url", "not a url");
    expect(loadConfig().getVaultPath("bad-url")).toBeNull();
    expect(registry.isRemoteVault("bad-url")).toBe(false);
  });
});

describe("dev flags", () => {
  afterEach(() => {
    delete process.env.DEV_SUPPRESS_WRITE_FAILURES;
    delete process.env.DEV_FORCE_READING_VIEW;
  });

  it("are off unless the variable is exactly true", () => {
    process.env.DEV_SUPPRESS_WRITE_FAILURES = "1";
    process.env.DEV_FORCE_READING_VIEW = "yes";

    const config = loadConfig();

    expect(config.devSuppressWriteFailures).toBe(false);
    expect(config.devForceReadingView).toBe(false);
  });

  it("are on when the variable is true", () => {
    process.env.DEV_SUPPRESS_WRITE_FAILURES = "true";
    process.env.DEV_FORCE_READING_VIEW = "true";

    const config = loadConfig();

    expect(config.devSuppressWriteFailures).toBe(true);
    expect(config.devForceReadingView).toBe(true);
  });
});
