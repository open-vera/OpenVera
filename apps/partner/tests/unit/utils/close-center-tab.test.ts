import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";

const abortMock = vi.fn();
const hostCommand = vi.fn(async (_cmd: { op: string }) => undefined);
const hostSessions: Record<string, unknown> = {};

vi.mock("@/shell", () => ({
  getChatRunner: () => ({ abort: abortMock }),
  useHostStore: () => ({
    booted: true,
    boot: vi.fn(),
    command: hostCommand,
    doc: {
      version: 4,
      projects: [],
      sessions: hostSessions,
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
    hostCommand.mockClear();
    for (const key of Object.keys(hostSessions)) delete hostSessions[key];
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

  it("flushes the closing tab's content through host.session.update", async () => {
    const { useChatStore } = await import("@/stores/chat");
    const { useAppStateStore } = await import("@/stores/app-state");
    const { closeCenterTabById } = await import("@/utils/close-center-tab");

    const chat = useChatStore();
    const appState = useAppStateStore();
    appState.isLoaded = true;
    const tabId = chat.ensureActiveChatTab();
    chat.append(
      { id: "m1", role: "user", content: "keep me", timestamp: 1 },
      tabId,
    );
    appState.doc.openTabIds = [tabId];
    appState.doc.sessions[tabId] = {
      id: tabId,
      projectId: null,
      title: "chat",
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    hostSessions[tabId] = { id: tabId };

    expect(closeCenterTabById(tabId)).toBe(true);

    const ops = hostCommand.mock.calls.map((call) => call[0].op);
    expect(ops).toContain("host.session.update");
    // A 22 MB document per closed tab is what this replaces.
    expect(ops).not.toContain("host.app.replace_state");
  });
});
