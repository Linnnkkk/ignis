import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { installExternalFilesOverrides } from "./external-files-guard.js";

let listeners;

function fakeObsidian() {
  const notices = [];

  class Notice {
    constructor(text) {
      notices.push(text);
    }
  }

  const Platform = {
    isDesktopApp: true,
    isDesktop: true,
    get canOpenExternalFiles() {
      return this.isDesktopApp && this.isDesktop;
    },
  };

  return { Platform, Notice, notices };
}

function fakeApp(commandIds) {
  const commands = {};

  for (const id of commandIds) {
    commands[id] = {
      id,
      callback: () => {
        throw new Error("original");
      },
    };
  }

  return {
    commands: {
      findCommand: (id) => commands[id],
    },
    dragManager: { draggable: null },
  };
}

function fakeDrag(type, selectors) {
  return {
    type,
    target: {
      closest: (selector) => (selectors.includes(selector) ? {} : null),
    },
    defaultPrevented: false,
    propagationStopped: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
    stopPropagation() {
      this.propagationStopped = true;
    },
  };
}

function dispatch(event) {
  for (const listener of listeners[event.type] || []) {
    listener(event);
  }

  return event;
}

beforeEach(() => {
  listeners = {};

  vi.stubGlobal("window", {
    addEventListener(type, listener) {
      (listeners[type] ||= []).push(listener);
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("installExternalFilesOverrides", () => {
  it("turns the external files flag off", () => {
    const obsidian = fakeObsidian();

    installExternalFilesOverrides(obsidian, fakeApp([]));

    expect(obsidian.Platform.canOpenExternalFiles).toBe(false);
  });

  it("shows a notice from the open file command", () => {
    const obsidian = fakeObsidian();
    const app = fakeApp(["app:open-file"]);
    installExternalFilesOverrides(obsidian, app);

    app.commands.findCommand("app:open-file").callback();

    expect(obsidian.notices).toEqual([
      "Ignis doesn't support opening files outside the vault.",
    ]);
  });

  it("installs without the open file command", () => {
    const obsidian = fakeObsidian();

    expect(() =>
      installExternalFilesOverrides(obsidian, fakeApp([])),
    ).not.toThrow();
  });

  it("cancels an outside drag over the tab bar", () => {
    installExternalFilesOverrides(fakeObsidian(), fakeApp([]));

    for (const type of ["dragenter", "dragover", "drop"]) {
      const event = dispatch(
        fakeDrag(type, [".workspace-tab-header-container"]),
      );

      expect(event.defaultPrevented).toBe(true);
      expect(event.propagationStopped).toBe(true);
    }
  });

  it("shows the notice on an outside drop on the tab bar only", () => {
    const obsidian = fakeObsidian();
    installExternalFilesOverrides(obsidian, fakeApp([]));

    for (const type of ["dragenter", "dragover", "dragover", "drop"]) {
      dispatch(fakeDrag(type, [".workspace-tab-header-container"]));
    }

    expect(obsidian.notices).toEqual([
      "Ignis doesn't support opening files outside the vault.",
    ]);
  });

  it("leaves a drag from inside Obsidian to the tab bar", () => {
    const obsidian = fakeObsidian();
    const app = fakeApp([]);
    app.dragManager.draggable = { type: "file" };
    installExternalFilesOverrides(obsidian, app);

    const event = dispatch(
      fakeDrag("drop", [".workspace-tab-header-container"]),
    );

    expect(event.defaultPrevented).toBe(false);
    expect(event.propagationStopped).toBe(false);
    expect(obsidian.notices).toEqual([]);
  });

  it("leaves an outside drag elsewhere alone", () => {
    const obsidian = fakeObsidian();
    installExternalFilesOverrides(obsidian, fakeApp([]));

    const event = dispatch(fakeDrag("drop", []));

    expect(event.defaultPrevented).toBe(false);
    expect(event.propagationStopped).toBe(false);
    expect(obsidian.notices).toEqual([]);
  });
});
