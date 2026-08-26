import {
  describe,
  it,
  expect,
  vi,
  afterAll,
  beforeEach,
  afterEach,
} from "vitest";
import { createRequire } from "module";
import path from "path";
import fs from "fs";
import os from "os";

const require = createRequire(import.meta.url);

const VAULT_ROOT = fs.mkdtempSync(
  path.join(os.tmpdir(), "metadata-channel-test-"),
);
process.env.VAULT_ROOT = VAULT_ROOT;

const VAULT_ID = "v";
const vaultDir = path.join(VAULT_ROOT, VAULT_ID);
fs.mkdirSync(vaultDir, { recursive: true });

const config = require("./config");
config.refreshVaults();
const bootstrapCache = require("./bootstrap-cache");
const { createMetadataChannel } = require("./metadata-channel");
const { watcher } = require("@ignis/server-core");

const REVISION_DEBOUNCE_MS = 250;

const seed = (name, content) =>
  fs.writeFileSync(path.join(vaultDir, name), content);

const fileStat = (size, mtime) => ({ size, mtime, ctime: mtime });

let sent = [];
let metadataChannel = null;

const wss = {
  channel: (name) => ({
    broadcastToVault(vaultId, message) {
      sent.push({ channel: name, vaultId, ...message });
    },
  }),
};

bootstrapCache.onEntrySwapped((vaultId, revision) =>
  metadataChannel.noteReplaced(vaultId, revision),
);
bootstrapCache.onVaultInvalidated((vaultId) =>
  metadataChannel.forgetVault(vaultId),
);

beforeEach(() => {
  metadataChannel = createMetadataChannel(wss);
  bootstrapCache.invalidateAll();
  fs.rmSync(vaultDir, { recursive: true, force: true });
  fs.mkdirSync(vaultDir, { recursive: true });
  sent = [];
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

afterAll(() => {
  fs.rmSync(VAULT_ROOT, { recursive: true, force: true });
});

describe("revision announcements", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("announces the revision once the applies settle", async () => {
    metadataChannel.noteRevision(VAULT_ID, '"a-1"');

    expect(sent).toEqual([]);

    await vi.advanceTimersByTimeAsync(REVISION_DEBOUNCE_MS);

    expect(sent).toEqual([
      {
        channel: "metadata",
        vaultId: VAULT_ID,
        type: "revision",
        revision: '"a-1"',
      },
    ]);
  });

  it("coalesces a burst into the revision it ended on", async () => {
    metadataChannel.noteRevision(VAULT_ID, '"a-1"');
    metadataChannel.noteRevision(VAULT_ID, '"a-2"');
    metadataChannel.noteRevision(VAULT_ID, '"a-3"');

    await vi.advanceTimersByTimeAsync(REVISION_DEBOUNCE_MS);

    expect(sent).toHaveLength(1);
    expect(sent[0].revision).toBe('"a-3"');
  });

  it("says nothing for a batch that reached no entry", async () => {
    metadataChannel.noteRevision(VAULT_ID, '"a-1"');
    await vi.advanceTimersByTimeAsync(REVISION_DEBOUNCE_MS);

    metadataChannel.noteRevision(VAULT_ID, null);
    await vi.advanceTimersByTimeAsync(REVISION_DEBOUNCE_MS);

    expect(sent).toHaveLength(1);
  });

  it("does not repeat a revision it already announced", async () => {
    metadataChannel.noteRevision(VAULT_ID, '"a-1"');
    await vi.advanceTimersByTimeAsync(REVISION_DEBOUNCE_MS);

    metadataChannel.noteRevision(VAULT_ID, '"a-1"');
    await vi.advanceTimersByTimeAsync(REVISION_DEBOUNCE_MS);

    expect(sent).toHaveLength(1);
  });

  it("keeps vaults apart", async () => {
    metadataChannel.noteRevision(VAULT_ID, '"a-1"');
    metadataChannel.noteRevision("w", '"a-2"');

    await vi.advanceTimersByTimeAsync(REVISION_DEBOUNCE_MS);

    expect(sent.map((m) => [m.vaultId, m.revision])).toEqual([
      [VAULT_ID, '"a-1"'],
      ["w", '"a-2"'],
    ]);
  });
});

describe("replacement announcements", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("announces a replacement without waiting", () => {
    metadataChannel.noteReplaced(VAULT_ID, '"a-9"');

    expect(sent).toEqual([
      {
        channel: "metadata",
        vaultId: VAULT_ID,
        type: "replaced",
        revision: '"a-9"',
      },
    ]);
  });

  it("supersedes a pending announcement, including one above it", async () => {
    metadataChannel.noteRevision(VAULT_ID, '"a-9"');
    metadataChannel.noteReplaced(VAULT_ID, '"a-4"');

    await vi.advanceTimersByTimeAsync(REVISION_DEBOUNCE_MS);

    expect(sent).toHaveLength(1);
    expect(sent[0].type).toBe("replaced");
  });

  it("does not repeat the replaced revision as an announcement", async () => {
    metadataChannel.noteReplaced(VAULT_ID, '"a-4"');
    metadataChannel.noteRevision(VAULT_ID, '"a-4"');

    await vi.advanceTimersByTimeAsync(REVISION_DEBOUNCE_MS);

    expect(sent).toHaveLength(1);
  });
});

describe("forgetting a vault", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("drops a pending announcement", async () => {
    metadataChannel.noteRevision(VAULT_ID, '"a-1"');
    metadataChannel.forgetVault(VAULT_ID);

    await vi.advanceTimersByTimeAsync(REVISION_DEBOUNCE_MS);

    expect(sent).toEqual([]);
  });
});

describe("against the cache", () => {
  it("announces a replacement when a crawl stores its entry", async () => {
    seed("a.md", "a");

    const entry = await bootstrapCache.getOrBuild(VAULT_ID);

    expect(sent).toEqual([
      {
        channel: "metadata",
        vaultId: VAULT_ID,
        type: "replaced",
        revision: entry.etag,
      },
    ]);
  });

  it("announces the revision an applied batch produced", async () => {
    seed("a.md", "a");

    await bootstrapCache.getOrBuild(VAULT_ID);

    vi.spyOn(watcher, "isWatching").mockReturnValue(true);
    sent = [];
    vi.useFakeTimers();

    const revision = await bootstrapCache.applyMutation(VAULT_ID, {
      type: "created",
      path: "b.md",
      stat: fileStat(3, 10),
    });

    metadataChannel.noteRevision(VAULT_ID, revision);
    await vi.advanceTimersByTimeAsync(REVISION_DEBOUNCE_MS);

    expect(sent).toEqual([
      {
        channel: "metadata",
        vaultId: VAULT_ID,
        type: "revision",
        revision,
      },
    ]);
  });

  it("says nothing for a batch that changed nothing", async () => {
    seed("a.md", "a");

    await bootstrapCache.getOrBuild(VAULT_ID);

    vi.spyOn(watcher, "isWatching").mockReturnValue(true);

    const event = {
      type: "modified",
      path: "b.md",
      stat: fileStat(3, 10),
    };

    const first = await bootstrapCache.applyMutation(VAULT_ID, event);

    sent = [];
    vi.useFakeTimers();
    metadataChannel.noteRevision(VAULT_ID, first);
    await vi.advanceTimersByTimeAsync(REVISION_DEBOUNCE_MS);

    const second = await bootstrapCache.applyMutation(VAULT_ID, event);

    metadataChannel.noteRevision(VAULT_ID, second);
    await vi.advanceTimersByTimeAsync(REVISION_DEBOUNCE_MS);

    expect(second).toBe(first);
    expect(sent).toHaveLength(1);
  });

  it("drops a pending announcement when the vault is invalidated", async () => {
    seed("a.md", "a");

    await bootstrapCache.getOrBuild(VAULT_ID);

    vi.spyOn(watcher, "isWatching").mockReturnValue(true);

    const revision = await bootstrapCache.applyMutation(VAULT_ID, {
      type: "created",
      path: "b.md",
      stat: fileStat(3, 10),
    });

    sent = [];
    vi.useFakeTimers();
    metadataChannel.noteRevision(VAULT_ID, revision);
    bootstrapCache.invalidateVault(VAULT_ID);

    await vi.advanceTimersByTimeAsync(REVISION_DEBOUNCE_MS);

    expect(sent).toEqual([]);
  });

  it("drops a cached vault's pending announcement on invalidateAll", async () => {
    seed("a.md", "a");

    await bootstrapCache.getOrBuild(VAULT_ID);

    vi.spyOn(watcher, "isWatching").mockReturnValue(true);

    const revision = await bootstrapCache.applyMutation(VAULT_ID, {
      type: "created",
      path: "b.md",
      stat: fileStat(3, 10),
    });

    sent = [];
    vi.useFakeTimers();
    metadataChannel.noteRevision(VAULT_ID, revision);
    bootstrapCache.invalidateAll();

    await vi.advanceTimersByTimeAsync(REVISION_DEBOUNCE_MS);

    expect(sent).toEqual([]);
  });
});
