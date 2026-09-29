// Obsidian's native-menu path uses Electron Menu APIs that can't render in a browser.

import { forceConfigValue } from "./forced-config.js";

// Disable the "Native menus" toggle in appearance settings.
function disableNativeMenuToggle() {
  const apply = () => {
    document.querySelectorAll(".setting-item-name").forEach((nameEl) => {
      if (!/native.?menu/i.test(nameEl.textContent)) {
        return;
      }

      const item = nameEl.closest(".setting-item");
      const input = item && item.querySelector('input[type="checkbox"]');

      if (!input || input.__ignisDisabled) {
        return;
      }

      input.disabled = true;
      input.__ignisDisabled = true;

      const container = input.closest(".checkbox-container");

      if (container) {
        container.title =
          "Forced off in Ignis - browser context can't render native menus.";
      }
    });
  };

  const observer = new MutationObserver(apply);

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
}

export function initNativeMenuGuard() {
  forceConfigValue(".obsidian/appearance.json", "nativeMenus", false);
  disableNativeMenuToggle();
}
