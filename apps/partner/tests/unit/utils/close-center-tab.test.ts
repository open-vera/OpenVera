import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";

const abortMock = vi.fn();

vi.mock("@/shell", () => ({
  getChatRunner: () => ({ abort: abortMock }),
  useHostStore: () => ({
    booted: true,
    boot: vi.fn(),
    command: vi.fn(),
    doc: {
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
      updatedAt: 0,
      projectRuntime: {},
      orchestrator: {
        runningSessionId: null,
        runningRequestId: null,
        queue: [],
        maxConcurrency: 1,
      },
    },
  }),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ destroy: vi.fn() }),
}));

vi.mock("@/utils/native-dialog", () => ({
  confirmDialog: vi.fn(async () => false),
}));

describe("closeCenterTabById", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    abortMock.mockReset();
  });

  it("aborts running agent via chat runner before closing", async () => {
    const { useChatStore } = await import("@/stores/chat");
    const { useAppStateStore } = await import("@/stores/app-state");
    const { closeCenterTabById } = await import("@/utils/close-center-tab");

    const chat = useChatStore();
    const appState = useAppStateStore();
    appState.isLoaded = true;
    const tabId = chat.ensureActiveChatTab();
    chat.setAgentRunning(true, tabId);
    appState.doc.openTabIds = [tabId];
    appState.doc.sessions[tabId] = {
      id: tabId,
      projectId: null,
      title: "chat",
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    expect(closeCenterTabById(tabId)).toBe(true);
    expect(abortMock).toHaveBeenCalled();
  });
});
