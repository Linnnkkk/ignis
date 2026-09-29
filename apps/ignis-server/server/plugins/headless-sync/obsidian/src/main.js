const { Plugin } = require("obsidian");
const { HeadlessSyncSettingTab } = require("./settings-tab");
const { initSyncStatusBar } = require("./sync-status-bar");
const { startCoreSyncGuard } = require("./core-sync-guard");
const api = require("./api");

class IgnisHeadlessSyncPlugin extends Plugin {
  async onload() {
    if (!window.__ignis) {
      console.log(
        "[ignis-headless-sync] Not running in Ignis - plugin is a no-op.",
      );
      return;
    }

    this.serverStatus = null;
    this.serverStatusFailed = false;
    this.vaults = null;
    this.vaultsError = null;
    this._settingTab = new HeadlessSyncSettingTab(this.app, this);

    this._syncStatusBarCleanup = initSyncStatusBar(this);
    this.loadServerStatus();

    this.addSettingTab(this._settingTab);

    this._coreSyncGuard = startCoreSyncGuard(this, api);

    this.addCommand({
      id: "start-sync",
      name: "Start server-side sync",
      callback: async () => {
        try {
          await api.startSync(this.app.vault.getName());
        } catch (e) {
          console.error("[ignis-headless-sync] Start failed:", e.message);
        }
      },
    });

    this.addCommand({
      id: "stop-sync",
      name: "Stop server-side sync",
      callback: async () => {
        try {
          await api.stopSync(this.app.vault.getName());
        } catch (e) {
          console.error("[ignis-headless-sync] Stop failed:", e.message);
        }
      },
    });

    this.addCommand({
      id: "show-status",
      name: "Show sync status",
      callback: () => {
        this.app.setting.open();
        this.app.setting.openTabById("ignis-headless-sync");
      },
    });

    console.log("[ignis-headless-sync] Loaded");
  }

  async loadServerStatus() {
    try {
      this.serverStatus = await api.getStatus();
      this.serverStatusFailed = false;
    } catch {
      this.serverStatus = null;
      this.serverStatusFailed = true;
    }

    this._settingTab.updateIfChanged();
  }

  async loadVaults() {
    try {
      const data = await api.getVaults();
      this.vaults = data.vaults || [];
      this.vaultsError = null;
    } catch (e) {
      this.vaults = null;
      this.vaultsError = e.message;
    }

    this._settingTab.updateIfChanged();
    return this.vaults;
  }

  setVaultState(vaultState) {
    if (!this.vaults) {
      return;
    }

    const index = this.vaults.findIndex(
      (v) => v.vaultId === vaultState.vaultId,
    );

    if (index === -1) {
      this.vaults.push(vaultState);
    } else {
      this.vaults[index] = vaultState;
    }

    this._settingTab.updateIfChanged();
  }

  onunload() {
    if (!window.__ignis) {
      return;
    }

    window.__ignisHeadlessSyncActive = false;

    if (this._coreSyncGuard) {
      this._coreSyncGuard.cleanup();
      this._coreSyncGuard = null;
    }

    if (this._syncStatusBarCleanup) {
      this._syncStatusBarCleanup();
      this._syncStatusBarCleanup = null;
    }
  }
}

module.exports = IgnisHeadlessSyncPlugin;
