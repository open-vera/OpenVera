import { beforeEach, describe, expect, it, vi } from "vitest";

const closeActiveCenterTabOrQuit = vi.fn(async () => true);

const mockPreview = {
  activeTabId: "code:file.ts" as string | null,
  tabs: [{ id: "code:file.ts", title: "file.ts", isDirty: false }] as Array<{
    id: string;
    title: string;
    isDirty: boolean;
  }>,
  closeTab: vi.fn(),
};

const mockQuickOpen = {
  open: false,
  toggle: vi.fn(),
  show: vi.fn(),
  hide: vi.fn(),
};

const mockTerminal = {
  open: false,
  activeTabId: "term-1" as string | null,
  tabs: [{ id: "term-1", title: "shell", cwd: "/tmp", exited: false }],
  toggle: vi.fn(),
  closeTab: vi.fn(),
  closePanel: vi.fn(),
};

const mockAppState = {
  previewProjectId: "proj-1" as string | null,
  createSession: vi.fn(() => "session-new"),
  getSession: vi.fn((id: string) =>
    id === "session-new"
      ? {
          id: "session-new",
          projectId: "proj-1",
          title: "对话 2",
          messages: [],
          createdAt: 1,
          updatedAt: 1,
        }
      : null,
  ),
};

vi.mock("@/utils/close-center-tab", () => ({
  closeActiveCenterTabOrQuit: () => closeActiveCenterTabOrQuit(),
}));

vi.mock("@/stores/app-state", () => ({
  useAppStateStore: () => mockAppState,
}));

vi.mock("@/stores/preview", () => ({
  usePreviewStore: () => mockPreview,
}));

vi.mock("@/stores/quick-open", () => ({
  useQuickOpenStore: () => mockQuickOpen,
}));

vi.mock("@/stores/terminal", () => ({
  useTerminalStore: () => mockTerminal,
}));

import {
  __test__,
  closeFocusedWorkAreaTab,
  PARTNER_SHORTCUTS,
} from "@/shortcuts/partner-shortcuts";

describe("PARTNER_SHORTCUTS", () => {
  beforeEach(() => {
    __test__.reset();
    closeActiveCenterTabOrQuit.mockClear();
    mockPreview.closeTab.mockClear();
    mockQuickOpen.toggle.mockClear();
    mockTerminal.toggle.mockClear();
    mockTerminal.closeTab.mockClear();
    mockTerminal.closePanel.mockClear();
    mockPreview.activeTabId = "code:file.ts";
    mockPreview.tabs = [{ id: "code:file.ts", title: "file.ts", isDirty: false }];
    mockTerminal.activeTabId = "term-1";
  });

  it("closes the active preview tab in preview scope without touching center", () => {
    const handled = PARTNER_SHORTCUTS["mod+w"].run({
      event: {} as KeyboardEvent,
      scope: "preview",
      chat: {} as never,
      preview: mockPreview as never,
      quickOpen: mockQuickOpen as never,
      terminal: mockTerminal as never,
    });

    expect(handled).toBe(true);
    expect(mockPreview.closeTab).toHaveBeenCalledWith("code:file.ts");
    expect(closeActiveCenterTabOrQuit).not.toHaveBeenCalled();
  });

  it("does not fall through to center when preview has no open file tabs", () => {
    mockPreview.activeTabId = null;
    mockPreview.tabs = [];

    const handled = PARTNER_SHORTCUTS["mod+w"].run({
      event: {} as KeyboardEvent,
      scope: "preview",
      chat: {} as never,
      preview: mockPreview as never,
      quickOpen: mockQuickOpen as never,
      terminal: mockTerminal as never,
    });

    expect(handled).toBe(true);
    expect(mockPreview.closeTab).not.toHaveBeenCalled();
    expect(closeActiveCenterTabOrQuit).not.toHaveBeenCalled();
  });

  it("closes the active center tab in center scope", () => {
    const handled = PARTNER_SHORTCUTS["mod+w"].run({
      event: {} as KeyboardEvent,
      scope: "center",
      chat: {
        activeTab: { id: "settings", kind: "settings", isAgentRunning: false },
        tabs: [
          { id: "chat:1", kind: "chat" },
          { id: "settings", kind: "settings" },
        ],
      } as never,
      preview: { tabs: [], activeTabId: null } as never,
      quickOpen: mockQuickOpen as never,
      terminal: mockTerminal as never,
    });

    expect(handled).toBe(true);
    expect(closeActiveCenterTabOrQuit).toHaveBeenCalled();
  });

  it("closes the active terminal tab in bottom scope", () => {
    const handled = PARTNER_SHORTCUTS["mod+w"].run({
      event: {} as KeyboardEvent,
      scope: "bottom",
      chat: {} as never,
      preview: mockPreview as never,
      quickOpen: mockQuickOpen as never,
      terminal: mockTerminal as never,
    });

    expect(handled).toBe(true);
    expect(mockTerminal.closeTab).toHaveBeenCalledWith("term-1");
  });

  it("dedupes native menu Cmd+W after preview close from keydown", () => {
    PARTNER_SHORTCUTS["mod+w"].run({
      event: {} as KeyboardEvent,
      scope: "preview",
      chat: {} as never,
      preview: mockPreview as never,
      quickOpen: mockQuickOpen as never,
      terminal: mockTerminal as never,
    });

    const handledAgain = closeFocusedWorkAreaTab();

    expect(handledAgain).toBe(true);
    expect(mockPreview.closeTab).toHaveBeenCalledTimes(1);
    expect(closeActiveCenterTabOrQuit).not.toHaveBeenCalled();
  });

  it("uses last focused preview scope for menu Close Tab", () => {
    __test__.setLastWorkAreaScope("preview");

    const handled = closeFocusedWorkAreaTab();
    expect(handled).toBe(true);
    expect(mockPreview.closeTab).toHaveBeenCalledWith("code:file.ts");
    expect(closeActiveCenterTabOrQuit).not.toHaveBeenCalled();
  });

  it("creates a session for the current project on mod+n", () => {
    const ensureSessionTab = vi.fn();
    mockAppState.createSession.mockClear();
    mockAppState.getSession.mockClear();

    const handled = PARTNER_SHORTCUTS["mod+n"].run({
      event: {} as KeyboardEvent,
      scope: "center",
      chat: { ensureSessionTab } as never,
      preview: mockPreview as never,
      quickOpen: mockQuickOpen as never,
      terminal: mockTerminal as never,
    });

    expect(handled).toBe(true);
    expect(mockAppState.createSession).toHaveBeenCalledWith({ projectId: "proj-1" });
    expect(ensureSessionTab).toHaveBeenCalledWith(
      expect.objectContaining({ id: "session-new" }),
    );
  });

  it("toggles quick open on mod+p", () => {
    const handled = PARTNER_SHORTCUTS["mod+p"].run({
      event: {} as KeyboardEvent,
      scope: "preview",
      chat: {} as never,
      preview: mockPreview as never,
      quickOpen: mockQuickOpen as never,
      terminal: mockTerminal as never,
    });

    expect(handled).toBe(true);
    expect(mockQuickOpen.toggle).toHaveBeenCalledTimes(1);
  });

  it("toggles terminal on mod+backtick", () => {
    const handled = PARTNER_SHORTCUTS["mod+backtick"].run({
      event: {} as KeyboardEvent,
      scope: "global",
      chat: {} as never,
      preview: mockPreview as never,
      quickOpen: mockQuickOpen as never,
      terminal: mockTerminal as never,
    });

    expect(handled).toBe(true);
    expect(mockTerminal.toggle).toHaveBeenCalledTimes(1);
  });
});
