import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it } from "vitest";
import { useChatStore } from "@/stores/chat";

describe("useChatStore", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it("appends and finalizes streaming messages", () => {
    const chat = useChatStore();
    const tabId = chat.ensureActiveChatTab();
    chat.append({
      id: "m1",
      role: "assistant",
      content: "",
      timestamp: Date.now(),
      isStreaming: true,
    }, tabId);

    chat.updateStreaming("m1", "hello", tabId);
    chat.finalizeMessage("m1", tabId);

    expect(chat.messages[0]?.content).toBe("hello");
    expect(chat.messages[0]?.isStreaming).toBe(false);
  });

  it("marks assistant messages as visible errors", () => {
    const chat = useChatStore();
    const tabId = chat.ensureActiveChatTab();
    chat.append({
      id: "m1",
      role: "assistant",
      content: "",
      timestamp: Date.now(),
      isStreaming: true,
    }, tabId);

    chat.markMessageError("m1", "模型服务拒绝了当前请求", tabId);

    expect(chat.messages[0]?.content).toBe("模型服务拒绝了当前请求");
    expect(chat.messages[0]?.isError).toBe(true);
    expect(chat.messages[0]?.isStreaming).toBe(false);
    expect(chat.lastError?.message).toBe("模型服务拒绝了当前请求");
  });

  it("clears visible errors when the next user message is sent", () => {
    const chat = useChatStore();
    const tabId = chat.ensureActiveChatTab();
    chat.setLastError("previous failure", tabId);

    chat.append({
      id: "user-message",
      role: "user",
      content: "retry",
      timestamp: Date.now(),
    }, tabId);

    expect(chat.lastError).toBeNull();
  });

  it("clears running state on abort", () => {
    const chat = useChatStore();
    const tabId = chat.ensureActiveChatTab();
    chat.setAgentRunning(true, tabId);
    chat.abort(tabId);
    expect(chat.isAgentRunning).toBe(false);
  });

  it("appends tool calls into an existing progress message", () => {
    const chat = useChatStore();
    const tabId = chat.ensureActiveChatTab();
    chat.append({
      id: "progress",
      role: "tool",
      content: "",
      timestamp: Date.now(),
      toolCalls: [],
    }, tabId);

    chat.appendToolCall("progress", {
      id: "tool-1",
      name: "read_file",
      input: { path: "README.md" },
    }, tabId);

    expect(chat.messages[0]?.toolCalls).toHaveLength(1);
    expect(chat.messages[0]?.content).toContain("read_file");
  });

  it("attaches tool results to the existing progress message", () => {
    const chat = useChatStore();
    const tabId = chat.ensureActiveChatTab();
    chat.append({
      id: "progress",
      role: "tool",
      content: "",
      timestamp: Date.now(),
      toolCalls: [
        {
          id: "tool-1",
          name: "execute_shell",
          input: { cmd: "git", args: ["status"] },
        },
      ],
    }, tabId);

    chat.appendToolResult("progress", {
      id: "tool-1",
      output: "clean",
      isError: false,
    }, tabId);

    expect(chat.messages[0]?.toolResults).toEqual([
      {
        id: "tool-1",
        output: "clean",
        isError: false,
      },
    ]);
  });

  it("keeps messages isolated between chat tabs", () => {
    const chat = useChatStore();
    const firstTabId = chat.ensureActiveChatTab();
    chat.append({
      id: "first",
      role: "user",
      content: "first tab",
      timestamp: Date.now(),
    }, firstTabId);

    const secondTabId = chat.createChatTab();
    chat.append({
      id: "second",
      role: "user",
      content: "second tab",
      timestamp: Date.now(),
    }, secondTabId);

    expect(chat.messages.map((message) => message.content)).toEqual(["second tab"]);
    chat.selectTab(firstTabId);
    expect(chat.messages.map((message) => message.content)).toEqual(["first tab"]);
  });

  it("opens settings as a center tab without replacing chat tabs", () => {
    const chat = useChatStore();
    chat.openSettingsTab();

    expect(chat.activeTab?.kind).toBe("settings");
    expect(chat.tabs.some((tab) => tab.kind === "chat")).toBe(true);
  });

  it("renames a default chat tab from the first user message", () => {
    const chat = useChatStore();
    const tabId = chat.ensureActiveChatTab();

    chat.append({
      id: "user-message",
      role: "user",
      content: "hi",
      timestamp: Date.now(),
    }, tabId);

    expect(chat.tabs.find((tab) => tab.id === tabId)?.title).toBe("hi");
  });

  it("ensures a chat tab exists for the center workspace", () => {
    const chat = useChatStore();
    chat.tabs = [];

    const tabId = chat.ensureDefaultChatTab();

    expect(chat.tabs).toHaveLength(1);
    expect(chat.tabs[0]?.id).toBe(tabId);
    expect(chat.activeTab?.kind).toBe("chat");
  });

  it("exports and restores chat snapshots", () => {
    const chat = useChatStore();
    const tabId = chat.ensureActiveChatTab();
    chat.append({
      id: "user-message",
      role: "user",
      content: "persist me",
      timestamp: 1,
    }, tabId);

    const snapshot = chat.exportSnapshot();
    chat.resetToDefault();
    const restored = chat.restoreSnapshot(snapshot);

    expect(restored).toBe(true);
    expect(chat.messages[0]?.content).toBe("persist me");
  });

  it("exports a single chat tab snapshot for task history", () => {
    const chat = useChatStore();
    const firstTabId = chat.ensureActiveChatTab();
    chat.append({
      id: "first",
      role: "user",
      content: "first tab",
      timestamp: 1,
    }, firstTabId);
    const secondTabId = chat.createChatTab();
    chat.append({
      id: "second",
      role: "user",
      content: "second tab",
      timestamp: 2,
    }, secondTabId);

    const snapshot = chat.exportTabSnapshot(firstTabId);

    expect(snapshot?.activeTabId).toBe(firstTabId);
    expect(snapshot?.tabs).toHaveLength(1);
    expect(snapshot?.tabs[0]?.messages[0]?.content).toBe("first tab");
  });

  it("opens a snapshot tab without replacing existing tabs", () => {
    const chat = useChatStore();
    const firstTabId = chat.ensureActiveChatTab();
    chat.append({
      id: "first",
      role: "user",
      content: "still open",
      timestamp: 1,
    }, firstTabId);

    const openedTabId = chat.openSnapshotTab({
      version: 1,
      activeTabId: "history-tab",
      tabs: [
        {
          id: "history-tab",
          title: "历史任务",
          kind: "chat",
          messages: [
            {
              id: "history-message",
              role: "assistant",
              content: "restored history",
              timestamp: 2,
            },
          ],
          isAgentRunning: true,
          currentTokenCount: 0,
          estimatedCost: 0,
        },
      ],
    });

    expect(openedTabId).toBe("history-tab");
    expect(chat.tabs.map((tab) => tab.id)).toContain(firstTabId);
    expect(chat.tabs.map((tab) => tab.id)).toContain("history-tab");
    expect(chat.messages[0]?.content).toBe("restored history");

    chat.selectTab(firstTabId);
    expect(chat.messages[0]?.content).toBe("still open");
  });

  it("selects the already-open tab when the snapshot is the same conversation", () => {
    const chat = useChatStore();
    const tabId = chat.ensureActiveChatTab();
    chat.append({
      id: "shared-message",
      role: "user",
      content: "local content",
      timestamp: 1,
    }, tabId);

    const openedTabId = chat.openSnapshotTab({
      version: 1,
      activeTabId: tabId,
      tabs: [
        {
          id: tabId,
          title: "旧历史",
          kind: "chat",
          messages: [
            {
              id: "shared-message",
              role: "user",
              content: "local content",
              timestamp: 1,
            },
          ],
          isAgentRunning: false,
          currentTokenCount: 0,
          estimatedCost: 0,
        },
      ],
    });

    expect(openedTabId).toBe(tabId);
    expect(chat.tabs).toHaveLength(1);
    expect(chat.messages[0]?.content).toBe("local content");
  });

  it("opens a colliding-id snapshot of a different conversation as a new tab", () => {
    const chat = useChatStore();
    const tabId = chat.ensureActiveChatTab();
    chat.append({
      id: "local-message",
      role: "user",
      content: "local content",
      timestamp: 1,
    }, tabId);

    const openedTabId = chat.openSnapshotTab({
      version: 1,
      activeTabId: tabId,
      tabs: [
        {
          id: tabId,
          title: "旧历史",
          kind: "chat",
          messages: [
            {
              id: "old-message",
              role: "assistant",
              content: "old history",
              timestamp: 2,
            },
          ],
          isAgentRunning: false,
          currentTokenCount: 0,
          estimatedCost: 0,
        },
      ],
    });

    expect(openedTabId).not.toBeNull();
    expect(openedTabId).not.toBe(tabId);
    expect(chat.tabs).toHaveLength(2);
    expect(chat.activeTabId).toBe(openedTabId);
    expect(chat.messages[0]?.content).toBe("old history");

    chat.selectTab(tabId);
    expect(chat.messages[0]?.content).toBe("local content");
  });

  it("normalizes running state when restoring snapshots", () => {
    const chat = useChatStore();

    chat.restoreSnapshot({
      version: 1,
      activeTabId: "tab-1",
      tabs: [
        {
          id: "tab-1",
          title: "old",
          kind: "chat",
          messages: [
            {
              id: "assistant",
              role: "assistant",
              content: "unfinished",
              timestamp: 1,
              isStreaming: true,
            },
          ],
          isAgentRunning: true,
          currentTokenCount: 0,
          estimatedCost: 0,
        },
      ],
    });

    expect(chat.isAgentRunning).toBe(false);
    expect(chat.messages[0]?.isStreaming).toBe(false);
  });

  it("clears queued status when a queued message starts processing", () => {
    const chat = useChatStore();
    const tabId = chat.ensureActiveChatTab();
    chat.append({
      id: "task-1",
      role: "user",
      content: "queued message",
      timestamp: Date.now(),
      queueStatus: "queued",
    }, tabId);

    chat.clearMessageQueueStatus("task-1", tabId);

    expect(chat.messages[0]?.queueStatus).toBeUndefined();
  });

  it("clears all queued messages when aborting the queue", () => {
    const chat = useChatStore();
    const tabId = chat.ensureActiveChatTab();
    chat.append({
      id: "task-1",
      role: "user",
      content: "first",
      timestamp: Date.now(),
      queueStatus: "queued",
    }, tabId);
    chat.append({
      id: "task-2",
      role: "user",
      content: "second",
      timestamp: Date.now(),
      queueStatus: "queued",
    }, tabId);

    chat.clearAllQueuedMessages();

    expect(chat.messages[0]?.queueStatus).toBeUndefined();
    expect(chat.messages[1]?.queueStatus).toBeUndefined();
  });

  it("resets the last chat tab instead of removing it", () => {
    const chat = useChatStore();
    const tabId = chat.ensureActiveChatTab();
    chat.append({
      id: "m1",
      role: "user",
      content: "keep one tab",
      timestamp: Date.now(),
    }, tabId);
    chat.setLastError("boom", tabId);

    chat.closeTab(tabId);

    expect(chat.tabs.filter((tab) => tab.kind === "chat")).toHaveLength(1);
    expect(chat.activeTabId).toBe(tabId);
    expect(chat.messages).toEqual([]);
    expect(chat.lastError).toBeNull();
    expect(chat.tabs.find((tab) => tab.id === tabId)?.title).toBe("对话 1");
  });

  describe("moveTab", () => {
    function openThree() {
      const chat = useChatStore();
      const first = chat.ensureActiveChatTab();
      const second = chat.createChatTab();
      const third = chat.createChatTab();
      return { chat, ids: [first, second, third] };
    }

    it("returns the new order after a reorder", () => {
      const { chat, ids } = openThree();

      expect(chat.moveTab(ids[2], 0)).toEqual([ids[2], ids[0], ids[1]]);
      expect(chat.tabs.map((tab) => tab.id)).toEqual([ids[2], ids[0], ids[1]]);
    });

    it("keeps the active tab selected across a reorder", () => {
      const { chat, ids } = openThree();
      chat.selectTab(ids[0]);

      chat.moveTab(ids[0], 3);

      expect(chat.activeTabId).toBe(ids[0]);
      expect(chat.tabs.at(-1)?.id).toBe(ids[0]);
    });

    it("returns null for a no-op drop", () => {
      const { chat, ids } = openThree();

      expect(chat.moveTab(ids[1], 1)).toBeNull();
      expect(chat.moveTab("missing", 0)).toBeNull();
      expect(chat.tabs.map((tab) => tab.id)).toEqual(ids);
    });
  });
});
