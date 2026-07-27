import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";

const hostCommand = vi.fn(async () => undefined);
const hostBoot = vi.fn(async () => undefined);

vi.mock("@/shell", () => ({
  useHostStore: () => ({
    booted: true,
    boot: hostBoot,
    command: hostCommand,
    doc: {
      protocolVersion: 1,
      revision: 1,
      version: 4,
      projects: [],
      sessions: {},
      openTabIds: [],
      activeTabId: null,
      previewProjectId: null,
      layout: {
        leftWidth: 240,
        previewWidth: 640,
        leftOpen: true,
        previewOpen: true,
        explorerOpen: true,
        editorOpen: true,
      },
      updatedAt: 1,
      projectRuntime: {},
      orchestrator: {
        runningSessionId: null,
        runningRequestId: null,
        queue: [],
        maxConcurrency: 1,
      },
      booted: true,
    },
  }),
}));

describe("app-state host projection", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    hostCommand.mockClear();
    hostBoot.mockClear();
  });

  it("loads by syncing from host", async () => {
    const { useAppStateStore } = await import("@/stores/app-state");
    const store = useAppStateStore();
    await store.load();
    expect(store.isLoaded).toBe(true);
    expect(store.doc.version).toBe(4);
  });

  it("persists via host.app.replace_state", async () => {
    const { useAppStateStore } = await import("@/stores/app-state");
    const store = useAppStateStore();
    store.isLoaded = true;
    await store.persist();
    expect(hostCommand).toHaveBeenCalledWith(
      expect.objectContaining({ op: "host.app.replace_state" }),
    );
  });

  describe("reorderOpenTabs", () => {
    function session(id: string) {
      return {
        id,
        projectId: null,
        title: id,
        messages: [],
        createdAt: 1,
        updatedAt: 1,
      };
    }

    async function storeWithOpenTabs(ids: string[]) {
      const { useAppStateStore } = await import("@/stores/app-state");
      const store = useAppStateStore();
      store.isLoaded = true;
      // openTabIds only survive normalization when the session exists.
      store.doc.sessions = Object.fromEntries(
        ids.filter((id) => id !== "settings").map((id) => [id, session(id)]),
      );
      store.doc.openTabIds = [...ids];
      hostCommand.mockClear();
      return store;
    }

    it("applies a dragged tab order and persists it", async () => {
      const store = await storeWithOpenTabs(["a", "b", "c"]);

      store.reorderOpenTabs(["c", "a", "b"]);

      expect(store.doc.openTabIds).toEqual(["c", "a", "b"]);
      expect(hostCommand).toHaveBeenCalledWith(
        expect.objectContaining({ op: "host.app.replace_state" }),
      );
    });

    it("keeps ids the caller did not mention", async () => {
      const store = await storeWithOpenTabs(["a", "b", "settings"]);

      store.reorderOpenTabs(["b", "a"]);

      expect(store.doc.openTabIds).toEqual(["b", "a", "settings"]);
    });

    it("does not persist an unchanged order", async () => {
      const store = await storeWithOpenTabs(["a", "b"]);

      store.reorderOpenTabs(["a", "b"]);

      expect(hostCommand).not.toHaveBeenCalled();
    });
  });
});
