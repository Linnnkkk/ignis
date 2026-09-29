let plugins = null;
let failed = false;

function get() {
  return plugins;
}

function loadFailed() {
  return failed;
}

async function refresh() {
  try {
    const res = await fetch("/api/plugins");

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    const fetched = await res.json();
    const changed =
      failed || JSON.stringify(fetched) !== JSON.stringify(plugins);

    if (changed) {
      plugins = fetched;
      failed = false;
    }

    return changed;
  } catch (e) {
    console.error("[ignis-bridge] Server plugins error:", e);
    const changed = !failed;
    failed = true;
    return changed;
  }
}

function setVaultEnabled(plugin, vaultId, enabled) {
  const others = plugin.enabledVaults.filter((id) => id !== vaultId);
  plugin.enabledVaults = enabled ? [...others, vaultId] : others;
}

function setEnabled(pluginId, vaultId, enabled) {
  const plugin = plugins?.find((p) => p.id === pluginId);

  if (plugin) {
    setVaultEnabled(plugin, vaultId, enabled);
  }
}

function setBundledEnabled(bundledPluginId, vaultId, enabled) {
  const plugin = plugins?.find((p) => p.bundledPluginId === bundledPluginId);

  if (plugin) {
    setVaultEnabled(plugin, vaultId, enabled);
  }
}

function watchPluginToggles() {
  const ws = window.__ignis.ws;

  const unsubEnable = ws.subscribe("virtual-plugin-enable", (msg) => {
    setBundledEnabled(msg.entry.id, msg.vault, true);
  });

  const unsubDisable = ws.subscribe("virtual-plugin-disable", (msg) => {
    setBundledEnabled(msg.id, msg.vault, false);
  });

  return () => {
    unsubEnable();
    unsubDisable();
  };
}

export { get, loadFailed, refresh, setEnabled, watchPluginToggles };
