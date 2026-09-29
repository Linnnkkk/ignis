import {
  registerReadTransform,
  registerWriteTransform,
} from "../fs/transforms.js";
import { fsShim } from "../fs/index.js";

function parseConfig(data) {
  const text = typeof data === "string" ? data : new TextDecoder().decode(data);

  return JSON.parse(text);
}

function readDiskValue(path, key) {
  try {
    const config = parseConfig(fsShim.readFileSync(path, "utf-8"));

    return key in config ? config[key] : undefined;
  } catch {
    return undefined;
  }
}

function patchVaultConfig(key, value, onRefused) {
  const tryPatch = () => {
    const vault = window.app && window.app.vault;

    if (
      !vault ||
      typeof vault.getConfig !== "function" ||
      typeof vault.setConfig !== "function"
    ) {
      return false;
    }

    vault.__ignisForcedKeys = vault.__ignisForcedKeys || new Set();

    if (vault.__ignisForcedKeys.has(key)) {
      return true;
    }

    const getConfig = vault.getConfig.bind(vault);
    const setConfig = vault.setConfig.bind(vault);

    vault.getConfig = function (k) {
      return k === key ? value : getConfig(k);
    };

    vault.setConfig = function (k, v) {
      if (k !== key) {
        return setConfig(k, v);
      }

      if (v !== value && onRefused) {
        onRefused();
      }

      return setConfig(key, value);
    };
    vault.__ignisForcedKeys.add(key);

    return true;
  };

  if (tryPatch()) {
    return;
  }

  const observer = new MutationObserver(() => {
    if (tryPatch()) {
      observer.disconnect();
    }
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
}

export function forceConfigValue(path, key, value, onRefused) {
  // get the on-disk value.
  const diskValue = readDiskValue(path, key);

  registerReadTransform(path, (data) => {
    try {
      const config = parseConfig(data);

      if (config[key] !== value) {
        config[key] = value;
        return JSON.stringify(config);
      }
    } catch {}

    return data;
  });

  registerWriteTransform(path, (data) => {
    try {
      const config = parseConfig(data);

      if (diskValue === undefined) {
        delete config[key];
      } else {
        config[key] = diskValue;
      }

      return JSON.stringify(config);
    } catch {
      return data;
    }
  });

  patchVaultConfig(key, value, onRefused);
}
