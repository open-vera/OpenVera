import { beforeEach, describe, expect, it } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { useTerminalStore } from "@/stores/terminal";

describe("useTerminalStore", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it("toggles panel visibility", () => {
    const store = useTerminalStore();
    expect(store.open).toBe(false);
    store.toggle();
    expect(store.open).toBe(true);
    store.closePanel();
    expect(store.open).toBe(false);
  });

  it("adds and activates tabs", () => {
    const store = useTerminalStore();
    const first = store.addTab({ title: "a@host", cwd: "/tmp" });
    const second = store.addTab({ title: "b@host", cwd: "/tmp" });
    expect(store.tabs).toHaveLength(2);
    expect(store.activeTabId).toBe(second.id);
    store.setActiveTab(first.id);
    expect(store.activeTabId).toBe(first.id);
  });

  it("closes last tab and collapses panel", () => {
    const store = useTerminalStore();
    const tab = store.addTab({ title: "shell", cwd: "/tmp" });
    expect(store.open).toBe(true);
    store.closeTab(tab.id);
    expect(store.tabs).toHaveLength(0);
    expect(store.open).toBe(false);
  });

  it("clamps height", () => {
    const store = useTerminalStore();
    store.setHeight(40);
    expect(store.height).toBe(120);
  });
});
