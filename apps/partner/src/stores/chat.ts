import { defineStore } from "pinia";
import { computed, ref } from "vue";
import type { ChatErrorNotice, ChatTab, Message, ToolCall, ToolResult } from "@/types";

const DEFAULT_CHAT_TAB_ID = "chat:default";
const SETTINGS_TAB_ID = "settings";
const DEFAULT_CHAT_TITLE_PATTERN = /^对话 \d+$/;
const SNAPSHOT_VERSION = 1;

export interface ChatSnapshot {
  version: number;
  activeTabId: string;
  tabs: ChatTab[];
}

function newChatTab(title: string): ChatTab {
  return {
    id: crypto.randomUUID(),
    title,
    kind: "chat",
    messages: [],
    isAgentRunning: false,
    currentTokenCount: 0,
    estimatedCost: 0,
  };
}

function createSettingsTab(): ChatTab {
  return {
    id: SETTINGS_TAB_ID,
    title: "设置",
    kind: "settings",
    messages: [],
    isAgentRunning: false,
    currentTokenCount: 0,
    estimatedCost: 0,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function summarizeTitle(content: string): string {
  const normalized = content.trim().replace(/\s+/g, " ");
  if (!normalized) return "";
  return normalized.length > 18 ? `${normalized.slice(0, 18)}…` : normalized;
}

function normalizeMessage(message: Message): Message {
  return {
    ...message,
    isStreaming: false,
  };
}

function normalizeChatTab(tab: ChatTab): ChatTab {
  return {
    ...tab,
    kind: "chat",
    messages: tab.messages.map(normalizeMessage),
    isAgentRunning: false,
  };
}

function fallbackChatTabs(): ChatTab[] {
  return [
    {
      ...newChatTab("对话 1"),
      id: DEFAULT_CHAT_TAB_ID,
    },
  ];
}

function parseSnapshot(value: unknown): ChatSnapshot | null {
  if (!isRecord(value) || !Array.isArray(value.tabs)) return null;
  const chatTabs = value.tabs
    .filter((tab): tab is ChatTab => isRecord(tab) && tab.kind === "chat")
    .map(normalizeChatTab);
  if (!chatTabs.length) return null;

  const activeTabId =
    typeof value.activeTabId === "string" &&
    chatTabs.some((tab) => tab.id === value.activeTabId)
      ? value.activeTabId
      : chatTabs[0]?.id;
  if (!activeTabId) return null;

  return {
    version: SNAPSHOT_VERSION,
    activeTabId,
    tabs: chatTabs,
  };
}

export const useChatStore = defineStore("chat", () => {
  const tabs = ref<ChatTab[]>(fallbackChatTabs());
  const activeTabId = ref(DEFAULT_CHAT_TAB_ID);

  const activeTab = computed(() => tabs.value.find((tab) => tab.id === activeTabId.value));
  const activeChatTab = computed(() =>
    tabs.value.find((tab) => tab.id === activeTabId.value && tab.kind === "chat"),
  );
  const messages = computed(() => activeChatTab.value?.messages ?? []);
  const isAgentRunning = computed(() => activeChatTab.value?.isAgentRunning ?? false);
  const lastError = computed(() => activeChatTab.value?.lastError ?? null);
  const currentTokenCount = computed(() => activeChatTab.value?.currentTokenCount ?? 0);
  const estimatedCost = computed(() => activeChatTab.value?.estimatedCost ?? 0);

  function createChatTab() {
    const count = tabs.value.filter((tab) => tab.kind === "chat").length + 1;
    const tab = newChatTab(`对话 ${count}`);
    tabs.value.push(tab);
    activeTabId.value = tab.id;
    return tab.id;
  }

  function ensureDefaultChatTab(): string {
    const activeExists = tabs.value.some((tab) => tab.id === activeTabId.value);
    const firstChatTab = tabs.value.find((tab) => tab.kind === "chat");
    if (firstChatTab && activeExists) return firstChatTab.id;

    if (firstChatTab) {
      activeTabId.value = firstChatTab.id;
      return firstChatTab.id;
    }

    const tab = {
      ...newChatTab("对话 1"),
      id: DEFAULT_CHAT_TAB_ID,
    };
    tabs.value.unshift(tab);
    activeTabId.value = tab.id;
    return tab.id;
  }

  function ensureActiveChatTab(): string {
    if (activeChatTab.value) return activeChatTab.value.id;
    const existing = tabs.value.find((tab) => tab.kind === "chat");
    if (existing) {
      activeTabId.value = existing.id;
      return existing.id;
    }
    return createChatTab();
  }

  function openSettingsTab() {
    if (!tabs.value.some((tab) => tab.id === SETTINGS_TAB_ID)) {
      tabs.value.push(createSettingsTab());
    }
    activeTabId.value = SETTINGS_TAB_ID;
  }

  function selectTab(id: string) {
    if (tabs.value.some((tab) => tab.id === id)) {
      activeTabId.value = id;
    }
  }

  function closeTab(id: string) {
    const tab = tabs.value.find((item) => item.id === id);
    if (!tab) return;
    if (tab.kind === "chat" && tabs.value.filter((item) => item.kind === "chat").length === 1) {
      return;
    }

    const removedIndex = tabs.value.findIndex((item) => item.id === id);
    tabs.value = tabs.value.filter((item) => item.id !== id);
    if (activeTabId.value === id) {
      activeTabId.value =
        tabs.value[Math.max(0, removedIndex - 1)]?.id ??
        tabs.value.find((item) => item.kind === "chat")?.id ??
        DEFAULT_CHAT_TAB_ID;
    }
  }

  function messagesForTab(tabId: string): Message[] {
    return tabs.value.find((tab) => tab.id === tabId && tab.kind === "chat")?.messages ?? [];
  }

  function append(message: Message, tabId?: string) {
    const resolvedTabId = tabId ?? ensureActiveChatTab();
    const tab = tabs.value.find((item) => item.id === resolvedTabId && item.kind === "chat");
    if (!tab) return;
    if (message.role === "user") {
      tab.lastError = null;
    }
    tab.messages.push(message);
    if (
      message.role === "user" &&
      tab.messages.filter((item) => item.role === "user").length === 1 &&
      DEFAULT_CHAT_TITLE_PATTERN.test(tab.title)
    ) {
      tab.title = summarizeTitle(message.content) || tab.title;
    }
  }

  function updateStreaming(id: string, delta: string, tabId?: string) {
    const resolvedTabId = tabId ?? ensureActiveChatTab();
    const message = messagesForTab(resolvedTabId).find((item) => item.id === id);
    if (message) {
      message.content += delta;
    }
  }

  function appendToolCall(messageId: string, toolCall: ToolCall, tabId?: string) {
    const resolvedTabId = tabId ?? ensureActiveChatTab();
    const message = messagesForTab(resolvedTabId).find((item) => item.id === messageId);
    if (!message || message.role !== "tool") return;
    message.toolCalls ??= [];
    message.toolCalls.push(toolCall);
    message.content = message.toolCalls
      .map((item) => `${item.name}(${JSON.stringify(item.input)})`)
      .join("\n");
  }

  function appendToolResult(messageId: string, toolResult: ToolResult, tabId?: string) {
    const resolvedTabId = tabId ?? ensureActiveChatTab();
    const message = messagesForTab(resolvedTabId).find((item) => item.id === messageId);
    if (!message || message.role !== "tool") return;
    message.toolResults ??= [];
    const existing = message.toolResults.find((item) => item.id === toolResult.id);
    if (existing) {
      Object.assign(existing, toolResult);
    } else {
      message.toolResults.push(toolResult);
    }
  }

  function finalizeMessage(id: string, tabId?: string) {
    const resolvedTabId = tabId ?? ensureActiveChatTab();
    const message = messagesForTab(resolvedTabId).find((item) => item.id === id);
    if (message) {
      message.isStreaming = false;
    }
  }

  function markMessageError(id: string, content: string, tabId?: string) {
    const resolvedTabId = tabId ?? ensureActiveChatTab();
    const message = messagesForTab(resolvedTabId).find((item) => item.id === id);
    setLastError(content, resolvedTabId);
    if (message) {
      message.content = content;
      message.isError = true;
      message.isStreaming = false;
    }
  }

  function setLastError(message: string, tabId?: string) {
    const resolvedTabId = tabId ?? ensureActiveChatTab();
    const tab = tabs.value.find((item) => item.id === resolvedTabId && item.kind === "chat");
    if (!tab) return;
    tab.lastError = {
      id: crypto.randomUUID(),
      message,
      timestamp: Date.now(),
    } satisfies ChatErrorNotice;
  }

  function clearLastError(tabId?: string) {
    const resolvedTabId = tabId ?? ensureActiveChatTab();
    const tab = tabs.value.find((item) => item.id === resolvedTabId && item.kind === "chat");
    if (tab) {
      tab.lastError = null;
    }
  }

  function setAgentRunning(running: boolean, tabId?: string) {
    const resolvedTabId = tabId ?? ensureActiveChatTab();
    const tab = tabs.value.find((item) => item.id === resolvedTabId && item.kind === "chat");
    if (tab) {
      tab.isAgentRunning = running;
    }
  }

  function abort(tabId?: string) {
    setAgentRunning(false, tabId);
  }

  function clear() {
    const tab = activeChatTab.value;
    if (!tab) return;
    tab.messages = [];
    tab.currentTokenCount = 0;
    tab.estimatedCost = 0;
  }

  function resetToDefault() {
    tabs.value = fallbackChatTabs();
    activeTabId.value = DEFAULT_CHAT_TAB_ID;
  }

  function exportSnapshot(): ChatSnapshot {
    const chatTabs = tabs.value
      .filter((tab) => tab.kind === "chat")
      .map(normalizeChatTab);
    const resolvedTabs = chatTabs.length ? chatTabs : fallbackChatTabs();
    const activeChatId = resolvedTabs.some((tab) => tab.id === activeTabId.value)
      ? activeTabId.value
      : resolvedTabs[0]?.id ?? DEFAULT_CHAT_TAB_ID;

    return {
      version: SNAPSHOT_VERSION,
      activeTabId: activeChatId,
      tabs: resolvedTabs,
    };
  }

  function exportTabSnapshot(tabId: string): ChatSnapshot | null {
    const tab = tabs.value.find((item) => item.id === tabId && item.kind === "chat");
    if (!tab) return null;
    return {
      version: SNAPSHOT_VERSION,
      activeTabId: tab.id,
      tabs: [normalizeChatTab(tab)],
    };
  }

  function restoreSnapshot(snapshot: unknown): boolean {
    const parsed = parseSnapshot(snapshot);
    if (!parsed) {
      resetToDefault();
      return false;
    }
    tabs.value = parsed.tabs;
    activeTabId.value = parsed.activeTabId;
    return true;
  }

  return {
    tabs,
    activeTabId,
    activeTab,
    activeChatTab,
    messages,
    isAgentRunning,
    lastError,
    currentTokenCount,
    estimatedCost,
    ensureDefaultChatTab,
    ensureActiveChatTab,
    createChatTab,
    openSettingsTab,
    selectTab,
    closeTab,
    append,
    appendToolCall,
    appendToolResult,
    updateStreaming,
    finalizeMessage,
    markMessageError,
    setLastError,
    clearLastError,
    messagesForTab,
    setAgentRunning,
    abort,
    clear,
    resetToDefault,
    exportSnapshot,
    exportTabSnapshot,
    restoreSnapshot,
  };
});
