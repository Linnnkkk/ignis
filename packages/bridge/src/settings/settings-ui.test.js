import { describe, it, expect, vi, beforeEach } from "vitest";

// Minimal DOM/Setting doubles: renderDefinitions only relies on empty(),
// createDiv({cls,text}) and the classic Setting surface.
function fakeEl(tag = "div") {
  const el = {
    tag,
    children: [],
    cls: "",
    text: "",
    empty() {
      this.children.length = 0;
      return this;
    },
    createDiv(opts = {}) {
      const child = fakeEl();
      child.cls = opts.cls || "";
      child.text = opts.text || "";
      this.children.push(child);
      return child;
    },
    isShown() {
      return true;
    },
  };

  return el;
}

const createdSettings = [];

class FakeSetting {
  constructor(containerEl) {
    this.containerEl = containerEl;
    this.name = null;
    this.desc = null;
    this.rendered = false;
    createdSettings.push(this);
  }

  setName(name) {
    this.name = name;
    return this;
  }

  setDesc(desc) {
    this.desc = desc;
    return this;
  }
}

class FakeSettingTab {
  constructor(app, setting) {
    this.app = app;
    this.setting = setting;
    this.containerEl = fakeEl();
  }
}

vi.mock("obsidian", () => ({
  Setting: FakeSetting,
  SettingTab: FakeSettingTab,
  setIcon: () => {},
}));

const { IgnisSettingTab, renderDefinitions } = await import("./settings-ui.js");

beforeEach(() => {
  createdSettings.length = 0;
});

describe("renderDefinitions (Obsidian 1.12.x path)", () => {
  it("renders a leaf definition through the classic Setting API", () => {
    const container = fakeEl();
    let renderedWith = null;

    renderDefinitions(container, [
      {
        name: "Content cache (MB)",
        desc: "Browser cache of file content.",
        render: (setting) => {
          renderedWith = setting;
        },
      },
    ]);

    expect(createdSettings).toHaveLength(1);
    expect(createdSettings[0].name).toBe("Content cache (MB)");
    expect(createdSettings[0].desc).toBe("Browser cache of file content.");
    expect(renderedWith).toBe(createdSettings[0]);
  });

  it("nests groups, applies cls and renders the heading", () => {
    const container = fakeEl();
    const inner = {};

    renderDefinitions(container, [
      {
        type: "group",
        cls: "ignis-plain",
        heading: "Caching",
        items: [{ name: "Inner", render: (s) => (inner.s = s) }],
      },
    ]);

    expect(container.children).toHaveLength(1);

    const group = container.children[0];

    expect(group.cls).toBe("setting-group ignis-plain");

    const heading = group.children.find((c) => c.cls === "setting-item-heading");

    expect(heading.text).toBe("Caching");
    expect(inner.s).toBe(createdSettings[0]);
  });

  it("skips a definition whose visible() returns false", () => {
    const container = fakeEl();

    renderDefinitions(container, [
      { name: "Hidden", visible: () => false, render: () => {} },
      { name: "Shown", visible: () => true, render: () => {} },
    ]);

    // Leaves mount through the classic Setting API, so they do not appear as
    // DOM children of the container; the created Setting is the evidence.
    expect(createdSettings).toHaveLength(1);
    expect(createdSettings[0].name).toBe("Shown");
    expect(createdSettings[0].containerEl).toBe(container);
  });

  it("skips a hidden group and everything inside it", () => {
    const container = fakeEl();

    renderDefinitions(container, [
      {
        type: "group",
        visible: () => false,
        items: [{ name: "Inside hidden group", render: () => {} }],
      },
    ]);

    expect(container.children).toHaveLength(0);
    expect(createdSettings).toHaveLength(0);
  });

  it("tolerates null entries and a definition with no render()", () => {
    const container = fakeEl();

    expect(() =>
      renderDefinitions(container, [
        null,
        { name: "Name only" },
        { desc: "desc only" },
      ]),
    ).not.toThrow();

    expect(createdSettings).toHaveLength(2);
  });

  it("renders the group's items into the group element, not the root", () => {
    const container = fakeEl();

    renderDefinitions(container, [
      { type: "group", items: [{ name: "Nested", render: () => {} }] },
    ]);

    expect(container.children).toHaveLength(1);

    // The nested leaf must mount into the group element, not the root.
    const group = container.children[0];

    expect(createdSettings).toHaveLength(1);
    expect(createdSettings[0].containerEl).toBe(group);
    expect(createdSettings[0].containerEl).not.toBe(container);
  });
});

describe("IgnisSettingTab 1.12.x display()", () => {
  it("clears the container then renders the definitions", () => {
    const tab = new IgnisSettingTab({}, "ignis-general", "General", "flame", () => [
      { name: "First", render: () => {} },
    ]);

    // Simulate a stale previous render.
    tab.containerEl.createDiv({ cls: "stale" });

    expect(tab.containerEl.children).toHaveLength(1);

    tab.display();

    expect(createdSettings).toHaveLength(1);
    expect(createdSettings[0].name).toBe("First");
    expect(
      tab.containerEl.children.some((c) => c.cls === "stale"),
    ).toBe(false);
  });

  it("keeps the 1.13.x declarative hook and does not shadow renderTab", () => {
    const definitions = () => [{ name: "D", render: () => {} }];
    const tab = new IgnisSettingTab({}, "ignis-vault", "Vault", "vault", definitions);

    // 1.13.x renders through the base class using this hook...
    expect(typeof tab.getSettingDefinitions).toBe("function");

    const fromHook = tab.getSettingDefinitions();

    expect(Array.isArray(fromHook)).toBe(true);
    expect(fromHook).toHaveLength(1);
    expect(fromHook[0].name).toBe("D");

    // ...so renderTab() must stay the base implementation, never ours.
    expect(Object.prototype.hasOwnProperty.call(tab, "renderTab")).toBe(false);
    expect(typeof tab.display).toBe("function");
  });
});
