import { Setting, SettingTab, setIcon } from "obsidian";

function createNavEl(tab, setting) {
  const nav = document.createElement("div");
  nav.className = "vertical-tab-nav-item tappable";

  if (tab.icon) {
    const iconEl = document.createElement("div");
    iconEl.className = "vertical-tab-nav-item-icon";

    if (tab.icon.startsWith("<svg") || tab.icon.startsWith("<img")) {
      iconEl.innerHTML = tab.icon;
    } else if (
      tab.icon.endsWith(".svg") ||
      tab.icon.endsWith(".webp") ||
      tab.icon.endsWith(".png")
    ) {
      iconEl.innerHTML = `<img src="${tab.icon}" class="svg-icon" width="24" height="24" />`;
    } else {
      setIcon(iconEl, tab.icon);
    }

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

  return nav;
}

// Obsidian 1.13.x renders a tab declaratively: its openTab() calls
// renderTab(), which walks getSettingDefinitions(). 1.12.x has no such
// machinery — its SettingTab base defines only hide(), and its openTab() calls
// display() instead. The definition tree is declarative, but every leaf builds
// its controls with the classic Setting API (setting.addText/addToggle/...),
// so 1.12 can render the very same definitions by walking the tree itself.
function renderDefinitions(containerEl, definitions) {
  for (const definition of definitions) {
    if (!definition || (definition.visible && !definition.visible())) {
      continue;
    }

    if (definition.type === "group") {
      const groupEl = containerEl.createDiv({
        cls: "setting-group" + (definition.cls ? " " + definition.cls : ""),
      });

      if (definition.heading) {
        groupEl.createDiv({
          cls: "setting-item-heading",
          text: definition.heading,
        });
      }

      renderDefinitions(groupEl, definition.items || []);
      continue;
    }

    const setting = new Setting(containerEl);

    if (definition.name) {
      setting.setName(definition.name);
    }

    if (definition.desc) {
      setting.setDesc(definition.desc);
    }

    if (typeof definition.render === "function") {
      definition.render(setting);
    }
  }
}

class IgnisSettingTab extends SettingTab {
  constructor(app, id, name, icon, definitions) {
    super(app, app.setting);
    this.id = id;
    this.name = name;
    this.icon = icon;
    this.definitions = definitions;
  }

  // 1.13.x path: the base class turns these into real settings, wires them
  // into the search index and tracks renderedItems.
  getSettingDefinitions() {
    return this.definitions(this);
  }

  // 1.12.x path: openTab() calls this. Deliberately does NOT define renderTab(),
  // so 1.13.x keeps using the base implementation above instead of this one.
  display() {
    this.containerEl.empty();
    renderDefinitions(this.containerEl, this.getSettingDefinitions());
  }
}

function createGroup(name, section) {
  const group = document.createElement("div");
  group.className = "vertical-tab-header-group";

  const title = document.createElement("div");
  title.className = "vertical-tab-header-group-title";
  title.textContent = name;
  group.appendChild(title);

  const items = document.createElement("div");
  items.className = "vertical-tab-header-group-items";
  items.setAttribute("data-section", section);
  group.appendChild(items);

  return { group, items };
}

function messageDefinition(text) {
  return {
    searchable: false,
    render: (setting) => {
      setting.settingEl.addClass("ignis-message");
      setting.setDesc(text);
    },
  };
}

function blockDefinition(build) {
  return {
    searchable: false,
    render: (setting) => {
      setting.settingEl.empty();
      build(setting.settingEl);
    },
  };
}

export {
  IgnisSettingTab,
  createNavEl,
  createGroup,
  messageDefinition,
  blockDefinition,
  renderDefinitions,
};
