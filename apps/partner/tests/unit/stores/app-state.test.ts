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
});
