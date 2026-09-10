import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);

const spawned = [];
let nextPid = 4000;

const obCli = require("./ob-cli.js");

obCli.runCommand = async () => ({ stdout: "", stderr: "" });

obCli.spawnOb = () => {
  const proc = new EventEmitter();

  proc.pid = nextPid++;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.killed = false;
  proc.kill = () => {
    proc.killed = true;
  };

  spawned.push(proc);

  return proc;
};

const { SyncManager } = require("./sync-manager.js");

const THRESHOLD_MS = 60000;
const CHECK_MS = THRESHOLD_MS / 4;

let dataDir;
let realPlatform;

function createManager(idleRestartMs = 0) {
  const broadcaster = { broadcastLog: vi.fn(), broadcastStatus: vi.fn() };
  const ctx = {
    dataDir,
    log: () => {},
    config: { headlessSyncIdleRestartMs: idleRestartMs },
  };

  return { manager: new SyncManager(ctx, broadcaster), broadcaster };
}

async function startedManager(idleRestartMs) {
  const created = createManager(idleRestartMs);

  await created.manager.setupSync("v1", path.join(dataDir, "v1"), "remote1");
  created.manager.startSync("v1");

  return { ...created, proc: spawned.at(-1) };
}

beforeAll(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ignis-headless-sync-"));
  realPlatform = process.platform;

  // mock linux for consistency
  Object.defineProperty(process, "platform", {
    value: "linux",
    configurable: true,
  });
});

afterAll(() => {
  Object.defineProperty(process, "platform", {
    value: realPlatform,
    configurable: true,
  });

  fs.rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(() => {
  spawned.length = 0;
});

describe("stopSync", () => {
  it("stops a vault whose process already exited", async () => {
    const { manager, broadcaster, proc } = await startedManager();

    proc.emit("close", 1);
    expect(manager.getState("v1").status).toBe("error");

    broadcaster.broadcastStatus.mockClear();

    const state = manager.stopSync("v1");

    expect(state.status).toBe("stopped");
    expect(state.error).toBe(null);
    expect(state.pid).toBe(null);
    expect(broadcaster.broadcastStatus).toHaveBeenCalledTimes(1);
  });

  it("throws for a vault with no sync configuration", () => {
    const { manager } = createManager();

    expect(() => manager.stopSync("missing")).toThrow(/No active sync/);
  });
});

describe("startSync over a running vault", () => {
  it("kills the existing process and respawns", async () => {
    const { manager, proc: stale } = await startedManager();

    const state = manager.startSync("v1");
    const fresh = spawned.at(-1);

    expect(fresh).not.toBe(stale);
    expect(stale.killed).toBe(true);
    expect(state.status).toBe("running");
    expect(state.pid).toBe(fresh.pid);
  });

  it("ignores the exit of the process it replaced", async () => {
    const { manager, proc: stale } = await startedManager();

    manager.startSync("v1");

    const fresh = spawned.at(-1);

    stale.emit("close", 1);

    const state = manager.getState("v1");

    expect(state.status).toBe("running");
    expect(state.pid).toBe(fresh.pid);
    expect(state.error).toBe(null);
  });
});

describe("idle restart", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("leaves an idle sync alone when unset", async () => {
    const { manager, proc } = await startedManager();

    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);

    expect(proc.killed).toBe(false);
    expect(manager.getState("v1").status).toBe("running");
  });

  it("restarts a silent sync", async () => {
    const { manager, proc } = await startedManager(THRESHOLD_MS);

    await vi.advanceTimersByTimeAsync(THRESHOLD_MS + CHECK_MS);

    const replacement = spawned.at(-1);
    const state = manager.getState("v1");

    expect(proc.killed).toBe(true);
    expect(replacement).not.toBe(proc);
    expect(state.status).toBe("running");
    expect(state.pid).toBe(replacement.pid);
    expect(state.error).toBe(null);

    await vi.advanceTimersByTimeAsync(CHECK_MS);

    expect(replacement.killed).toBe(false);
  });

  it("names the setting in the vault log when it restarts", async () => {
    const { manager } = await startedManager(THRESHOLD_MS);

    await vi.advanceTimersByTimeAsync(THRESHOLD_MS + CHECK_MS);

    const lines = manager.getLogs("v1").map((entry) => entry.line);

    expect(
      lines.some((line) => line.includes("HEADLESS_SYNC_IDLE_RESTART_MS")),
    ).toBe(true);
  });

  it("ignores the exit of the process it restarted", async () => {
    const { manager, proc } = await startedManager(THRESHOLD_MS);

    await vi.advanceTimersByTimeAsync(THRESHOLD_MS + CHECK_MS);

    const replacement = spawned.at(-1);

    proc.emit("close", null);

    const state = manager.getState("v1");

    expect(state.status).toBe("running");
    expect(state.pid).toBe(replacement.pid);
    expect(state.error).toBe(null);
  });

  it("measures a restarted sync from its own start", async () => {
    const { manager, proc } = await startedManager(THRESHOLD_MS);

    proc.stdout.emit("data", Buffer.from("Synced 1 file\n"));
    manager.stopSync("v1");

    await vi.advanceTimersByTimeAsync(THRESHOLD_MS * 5);

    manager.startSync("v1");

    const restarted = spawned.at(-1);

    await vi.advanceTimersByTimeAsync(CHECK_MS);

    expect(restarted.killed).toBe(false);
    expect(manager.getState("v1").status).toBe("running");
  });

  it("leaves a sync that keeps logging alone", async () => {
    const { manager, proc } = await startedManager(THRESHOLD_MS);

    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(THRESHOLD_MS / 2);
      proc.stdout.emit("data", Buffer.from("Synced 1 file\n"));
    }

    expect(proc.killed).toBe(false);
    expect(manager.getState("v1").status).toBe("running");
  });
});
