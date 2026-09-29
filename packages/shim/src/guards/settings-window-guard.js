// Obsidian's settings popout window can't open in a browser.

import { forceConfigValue } from "./forced-config.js";

function notifyRefused() {
  const Notice = window.__ignis?.obsidian?.Notice;

  if (Notice) {
    new Notice("Settings can't open in a separate window in the browser.");
  }
}

export function initSettingsWindowGuard() {
  forceConfigValue(
    ".obsidian/app.json",
    "settingsPopoutWindow",
    false,
    notifyRefused,
  );
}
