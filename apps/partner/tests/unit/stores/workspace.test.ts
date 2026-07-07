import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkspaceStore } from "@/stores/workspace";

const localValues = new Map<string, string>();

describe("useWorkspaceStore", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    localValues.clear();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => localValues.get(key) ?? null,
        setItem: (key: string, value: string) => {
          localValues.set(key, value);
        },
      },
    });
  });

  it("persists workspace roots per window", () => {
    const workspace = useWorkspaceStore();

    workspace.setWindowId("review");
    workspace.setRoot("/repo/review");

    expect(localValues.get("partner:workspace-root:review")).toBe("/repo/review");
  });

  it("restores the workspace root for the current window", () => {
    localValues.set("partner:workspace-root:main", "/repo/main");
    const workspace = useWorkspaceStore();

    expect(workspace.restoreRoot()).toBe("/repo/main");
    expect(workspace.rootPath).toBe("/repo/main");
  });

  it("falls back to the legacy workspace root key", () => {
    localValues.set("partner:workspace-root", "/repo/legacy");
    const workspace = useWorkspaceStore();

    expect(workspace.restoreRoot()).toBe("/repo/legacy");
  });
});
