import { Notice } from "obsidian";

let settings = null;
let failed = false;

function get() {
  return settings;
}

function loadFailed() {
  return failed;
}

function set(value) {
  settings = value;
  failed = false;
}

async function refresh() {
  try {
    const res = await fetch("/api/settings");

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    const fetched = await res.json();
    const changed =
      failed || JSON.stringify(fetched) !== JSON.stringify(settings);

    if (changed) {
      set(fetched);
    }

    return changed;
  } catch {
    const changed = !failed;
    failed = true;
    return changed;
  }
}

async function save(partial) {
  try {
    const res = await fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(partial),
    });

    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      throw new Error(data.error || "Save failed");
    }

    set(data);
    return data;
  } catch (e) {
    new Notice(`Failed to save setting: ${e.message}`);
    return false;
  }
}

export { get, loadFailed, refresh, save };
