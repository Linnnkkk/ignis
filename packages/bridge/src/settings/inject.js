import { Platform } from "obsidian";
import * as generalTab from "./general-tab.js";
import * as vaultTab from "./vault-tab.js";
import * as serverPluginsTab from "./server-plugins-tab.js";
import * as serverSettings from "./server-settings.js";
import * as pluginList from "./plugin-list.js";
import { IgnisSettingTab, createNavEl, createGroup } from "./settings-ui.js";
import {
  allIgnisNavEls,
  setupPluginTabs,
  reconcilePluginTabs,
  hideIgnisFromCommunityPlugins,
  restoreCommunityPlugins,
  clearOwnedPluginIds,
  disconnectCommunityObserver,
} from "./plugin-tabs.js";

let ignisTabs = [];

function createIgnisTabs(app) {
  return [
    new IgnisSettingTab(
      app,
      "ignis-general",
      "General",
      "flame",
      generalTab.settingDefinitions,
    ),
    new IgnisSettingTab(
      app,
      "ignis-vault",
      "Vault",
      "vault",
      vaultTab.settingDefinitions,
    ),
    new IgnisSettingTab(
      app,
      "ignis-core-plugins",
      "Core plugins",
      "blocks",
      serverPluginsTab.settingDefinitions,
    ),
  ];
}

// Re-render a tab whose backing data changed. 1.13.x rerenders declaratively
// through update(); 1.12.x has no update(), so the tab that is on screen
// re-runs its imperative display(). Without this the 1.12.x settings pane
// would throw as soon as server settings finished loading.
function refreshTab(tab) {
  if (typeof tab.update === "function") {
    tab.update();
    return;
  }

  if (tab.containerEl && tab.containerEl.isShown && tab.containerEl.isShown()) {
    tab.display();
  }
}

function refreshIgnisSettings() {
  for (const store of [serverSettings, pluginList]) {
    store.refresh().then((changed) => {
      if (!changed) {
        return;
      }

      for (const tab of ignisTabs) {
        refreshTab(tab);
      }
    });
  }
}

function removeExistingIgnisGroups(setting) {
  const sections = setting.tabHeadersEl.querySelectorAll(
    '[data-section="ignis"], [data-section="ignis-core-plugins"]',
  );

  for (const items of sections) {
    items.closest(".vertical-tab-header-group")?.remove();
  }
}

function writeVersionRow(versionSetting, ignisVersion) {
  const desc = versionSetting.descEl;

  desc.empty();
  desc.createEl("strong", { text: `Running in Ignis v${ignisVersion}` });
  desc.createEl("br");
  desc.appendText(
    "Obsidian is served through Ignis. There's no installer to update.",
  );
}

// 1.12.x has no updateVersionSetting/currentVersionSetting hooks on the About
// tab, so rewrite the rendered "Installer version:" row in the DOM instead.
// This is the pre-1.13 code path, kept for the older release line.
function replaceInstallerVersionRow(setting, ignisVersion) {
  const container = setting.tabContentContainer || setting.contentEl;

  if (!container) {
    return;
  }

  const rows = container.querySelectorAll(".setting-item");

  for (const row of rows) {
    const desc = row.querySelector(".setting-item-description");

    if (!desc || !desc.textContent.startsWith("Installer version:")) {
      continue;
    }

    desc.empty();
    desc.createEl("strong", { text: `Running in Ignis v${ignisVersion}` });
    desc.createEl("br");
    desc.appendText(
      "Obsidian is served through Ignis. There's no installer to update.",
    );
    break;
  }
}

// Replace the installer version with the Ignis version.
function patchVersionRow(setting, ignisVersion) {
  const aboutTab = setting.settingTabs.find((t) => t.id === "about");

  if (!aboutTab || aboutTab._ignisOriginalUpdateVersionSetting) {
    return;
  }

  // Only 1.13.x exposes these hooks; calling through to a missing
  // updateVersionSetting would throw while the About tab renders.
  if (typeof aboutTab.updateVersionSetting !== "function") {
    replaceInstallerVersionRow(setting, ignisVersion);
    return;
  }

  const original = aboutTab.updateVersionSetting;
  aboutTab._ignisOriginalUpdateVersionSetting = original;

  aboutTab.updateVersionSetting = function () {
    original.call(this);

    if (this.currentVersionSetting) {
      writeVersionRow(this.currentVersionSetting, ignisVersion);
    }
  };

  if (aboutTab.currentVersionSetting) {
    writeVersionRow(aboutTab.currentVersionSetting, ignisVersion);
  }
}

function unpatchVersionRow(setting) {
  const aboutTab = setting.settingTabs.find((t) => t.id === "about");

  if (aboutTab?._ignisOriginalUpdateVersionSetting) {
    aboutTab.updateVersionSetting = aboutTab._ignisOriginalUpdateVersionSetting;
    delete aboutTab._ignisOriginalUpdateVersionSetting;
  }
}

function patchOpenTab(setting) {
  if (setting._ignisOpenTabPatched) {
    return;
  }

  const original = setting.openTab.bind(setting);
  setting._ignisOriginalOpenTab = original;

  setting.openTab = function (tab) {
    // Clear is-active from all ignis nav items.
    for (const [, el] of allIgnisNavEls) {
      el.removeClass("is-active");
    }

    original(tab);

    // If the opened tab is one of ours, highlight it.
    const navEl = allIgnisNavEls.get(tab.id);

    if (navEl) {
      navEl.addClass("is-active");
    }
  };

  setting._ignisOpenTabPatched = true;
}

function injectIgnisSettings(setting, plugin) {
  removeExistingIgnisGroups(setting);
  clearOwnedPluginIds();
  allIgnisNavEls.clear();

  patchOpenTab(setting);
  patchVersionRow(setting, plugin.manifest.version);

  const ignis = createGroup("Ignis", "ignis");

  for (const tab of ignisTabs) {
    tab.navEl = createNavEl(tab, setting);
    ignis.items.appendChild(tab.navEl);
    allIgnisNavEls.set(tab.id, tab.navEl);
  }

  // Obsidian 1.13.x exposes tabGroupContainerEl; 1.12.x only has tabHeadersEl.
  // Fall back so the Ignis groups mount on both release lines.
  const headerContainer = setting.tabGroupContainerEl || setting.tabHeadersEl;
  headerContainer.appendChild(ignis.group);

  const corePlugins = createGroup("Ignis Core Plugins", "ignis-core-plugins");
  headerContainer.appendChild(corePlugins.group);

  hideIgnisFromCommunityPlugins(setting);
  setupPluginTabs(setting, corePlugins.items);

  return ignisTabs;
}

function patchSettingsModal(plugin) {
  const setting = plugin.app.setting;
  const original = setting.onOpen;
  plugin._originalOnOpen = original;

  ignisTabs = createIgnisTabs(plugin.app);

  // searchIndex is a 1.13.x settings-search API; 1.12.x has no search index at
  // all, so registering the tabs there must be skipped rather than throwing.
  for (const tab of ignisTabs) {
    // update() primes the declarative setting items and is 1.13.x only; on
    // 1.12.x the tab renders itself through display() when it is opened.
    if (typeof tab.update === "function") {
      tab.update();
    }

    if (setting.searchIndex) {
      setting.searchIndex.addTab(tab);
    }
  }

  setting.onOpen = function () {
    // read before obsidian overwrites it.
    const lastTabId = this.lastTabId;

    original.call(this);

    const tabs = injectIgnisSettings(this, plugin);
    const lastTab = tabs.find((tab) => tab.id === lastTabId);

    if (lastTab && !Platform.isPhone) {
      this.openTab(lastTab);
    }

    refreshIgnisSettings();
  };
}

function unpatchSettingsModal(plugin) {
  const setting = plugin.app.setting;

  if (plugin._originalOnOpen) {
    setting.onOpen = plugin._originalOnOpen;
  }

  for (const tab of ignisTabs) {
    if (setting.searchIndex) {
      setting.searchIndex.removeTab(tab);
    }
  }

  ignisTabs = [];

  // 1.13.x only; 1.12.x settings has no search index to refresh.
  if (typeof setting.refreshSearch === "function") {
    setting.refreshSearch();
  }

  if (setting._ignisOriginalOpenTab) {
    setting.openTab = setting._ignisOriginalOpenTab;
    delete setting._ignisOriginalOpenTab;
  }

  delete setting._ignisOpenTabPatched;

  unpatchVersionRow(setting);
  restoreCommunityPlugins(setting);
  disconnectCommunityObserver();
  clearOwnedPluginIds();
}

export {
  patchSettingsModal,
  unpatchSettingsModal,
  refreshIgnisSettings,
  reconcilePluginTabs,
};
