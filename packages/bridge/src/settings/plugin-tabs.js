import { setIcon } from "obsidian";
import { isIgnisPlugin } from "../plugin-registry.js";

// All ignis-managed nav elements (both Ignis group and Ignis Core Plugins group).
// Shared with inject.js so the openTab patch can manage is-active across all of them.
const allIgnisNavEls = new Map(); // tab id -> nav element

// Tracks which plugin IDs have nav items we created.
const ownedPluginIds = new Set();

let communityObserver = null;

function ignisSection(setting, section) {
  return setting.tabHeadersEl.querySelector(`[data-section="${section}"]`);
}

function addPluginNavItem(pluginId, setting, corePluginsItems) {
  const tab = setting.pluginTabs.find((t) => t.id === pluginId);

  if (!tab) {
    return;
  }

  if (ownedPluginIds.has(pluginId)) {
    return;
  }

  const nav = document.createElement("div");
  nav.className = "vertical-tab-nav-item tappable";

  if (tab.icon) {
    const iconEl = document.createElement("div");
    iconEl.className = "vertical-tab-nav-item-icon";
    setIcon(iconEl, tab.icon);
    nav.appendChild(iconEl);
  }

  const title = document.createElement("div");
  title.className = "vertical-tab-nav-item-title";
  title.textContent = tab.name;
  nav.appendChild(title);

  const chevron = document.createElement("div");
  chevron.className = "vertical-tab-nav-item-chevron";
  nav.appendChild(chevron);

  nav.addEventListener("click", () => {
    setting.openTab(tab);
  });

  corePluginsItems.appendChild(nav);
  ownedPluginIds.add(pluginId);
  allIgnisNavEls.set(pluginId, nav);
}

function removePluginNavItem(pluginId) {
  const nav = allIgnisNavEls.get(pluginId);

  if (nav && ownedPluginIds.has(pluginId)) {
    nav.remove();
    ownedPluginIds.delete(pluginId);
    allIgnisNavEls.delete(pluginId);
  }
}

function hideIgnisFromCommunityPlugins(setting) {
  const cpTab = setting.settingTabs.find((t) => t.id === "community-plugins");

  if (!cpTab || cpTab._ignisOriginalGetSettingDefinitions) {
    return;
  }

  const original = cpTab.getSettingDefinitions;
  cpTab._ignisOriginalGetSettingDefinitions = original;

  cpTab.getSettingDefinitions = function () {
    const definitions = original.call(this);

    for (const [id, definition] of Object.entries(this.pluginDefinitions)) {
      definition.visible = () => !isIgnisPlugin(id);
    }

    return definitions;
  };

  cpTab.update();
}

function restoreCommunityPlugins(setting) {
  const cpTab = setting.settingTabs.find((t) => t.id === "community-plugins");

  if (cpTab?._ignisOriginalGetSettingDefinitions) {
    cpTab.getSettingDefinitions = cpTab._ignisOriginalGetSettingDefinitions;
    delete cpTab._ignisOriginalGetSettingDefinitions;
    cpTab.update();
  }
}

function hideIgnisNavFromCommunityGroup(setting) {
  const items = setting.communityPluginTabContainer;
  const communityGroup = items.closest(".vertical-tab-header-group");

  for (const tab of setting.pluginTabs) {
    if (isIgnisPlugin(tab.id) && tab.navEl?.parentElement === items) {
      tab.navEl.style.display = "none";
    }
  }

  const hasVisible = Array.from(items.children).some(
    (el) => el.style.display !== "none",
  );

  communityGroup.style.display = hasVisible ? "" : "none";
}

function hideCorePluginsGroupIfEmpty(setting) {
  let hasConnected = false;

  for (const id of ownedPluginIds) {
    const nav = allIgnisNavEls.get(id);

    if (nav?.isConnected) {
      hasConnected = true;
      break;
    }
  }

  const group = ignisSection(setting, "ignis-core-plugins")?.closest(
    ".vertical-tab-header-group",
  );

  if (group) {
    group.style.display = hasConnected ? "" : "none";
  }
}

function setupPluginTabs(setting, corePluginsItems) {
  for (const tab of setting.pluginTabs) {
    if (isIgnisPlugin(tab.id) && tab.id !== "ignis-bridge") {
      addPluginNavItem(tab.id, setting, corePluginsItems);
    }
  }

  hideIgnisNavFromCommunityGroup(setting);
  hideCorePluginsGroupIfEmpty(setting);

  disconnectCommunityObserver();

  communityObserver = new MutationObserver(() => {
    for (const tab of setting.pluginTabs) {
      if (isIgnisPlugin(tab.id) && tab.id !== "ignis-bridge") {
        addPluginNavItem(tab.id, setting, corePluginsItems);
      }
    }

    hideIgnisNavFromCommunityGroup(setting);
    hideCorePluginsGroupIfEmpty(setting);
  });

  communityObserver.observe(setting.communityPluginTabContainer, {
    childList: true,
    subtree: true,
  });
}

function disconnectCommunityObserver() {
  if (communityObserver) {
    communityObserver.disconnect();
    communityObserver = null;
  }
}

function reconcilePluginTabs(setting) {
  const corePluginsItems = ignisSection(setting, "ignis-core-plugins");

  if (!corePluginsItems) {
    return;
  }

  const activeIds = new Set(
    setting.pluginTabs
      .filter((t) => isIgnisPlugin(t.id) && t.id !== "ignis-bridge")
      .map((t) => t.id),
  );

  for (const id of ownedPluginIds) {
    if (!activeIds.has(id)) {
      removePluginNavItem(id);
    }
  }

  for (const id of activeIds) {
    addPluginNavItem(id, setting, corePluginsItems);
  }

  hideIgnisNavFromCommunityGroup(setting);
  hideCorePluginsGroupIfEmpty(setting);
}

function clearOwnedPluginIds() {
  ownedPluginIds.clear();
}

export {
  allIgnisNavEls,
  setupPluginTabs,
  reconcilePluginTabs,
  hideIgnisFromCommunityPlugins,
  restoreCommunityPlugins,
  clearOwnedPluginIds,
  disconnectCommunityObserver,
};
