import { SettingTab, setIcon } from "obsidian";

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

class IgnisSettingTab extends SettingTab {
  constructor(app, id, name, icon, definitions) {
    super(app, app.setting);
    this.id = id;
    this.name = name;
    this.icon = icon;
    this.definitions = definitions;
  }

  getSettingDefinitions() {
    return this.definitions(this);
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
};
