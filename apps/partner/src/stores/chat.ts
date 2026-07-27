import { defineStore } from "pinia";
import { computed, ref } from "vue";
import type { ChatErrorNotice, ChatTab, Message, TokenUsage, ToolCall, ToolResult } from "@/types";

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
    runUsage: null,
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
    runUsage: null,
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
    queueStatus: undefined,
  };
}

function normalizeChatTab(tab: ChatTab): ChatTab {
  return {
    ...tab,
    kind: "chat",
    messages: tab.messages.map(normalizeMessage),
    isAgentRunning: false,
    activeTaskId: null,
    lastTaskId: tab.lastTaskId ?? tab.activeTaskId ?? null,
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
  const runUsage = computed(() => activeChatTab.value?.runUsage ?? null);

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

  function resetChatTab(tab: ChatTab, title = "对话 1") {
    tab.title = title;
    tab.messages = [];
    tab.isAgentRunning = false;
    tab.activeTaskId = null;
    tab.lastTaskId = null;
    tab.lastError = null;
    tab.currentTokenCount = 0;
    tab.estimatedCost = 0;
    tab.runUsage = null;
  }

  function closeTab(id: string) {
    const tab = tabs.value.find((item) => item.id === id);
    if (!tab) return;

    const chatTabs = tabs.value.filter((item) => item.kind === "chat");
    if (tab.kind === "chat" && chatTabs.length <= 1) {
      resetChatTab(tab);
      activeTabId.value = tab.id;
      return;
    }

    const removedIndex = tabs.value.findIndex((item) => item.id === id);
    tabs.value = tabs.value.filter((item) => item.id !== id);
    if (activeTabId.value === id) {
      activeTabId.value =
        tabs.value[Math.max(0, removedIndex - 1)]?.id ??
        tabs.value.find((item) => item.kind === "chat")?.id ??
        tabs.value[0]?.id ??
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

  /** Stamp a segment (or the whole turn, via its last message) as finished. */
  function setMessageEndedAt(id: string, endedAt: number, tabId?: string) {
    const resolvedTabId = tabId ?? ensureActiveChatTab();
    const message = messagesForTab(resolvedTabId).find((item) => item.id === id);
    if (message) {
      message.endedAt = endedAt;
    }
  }

  function closeTurn(turnId: string, endedAt: number, tabId?: string) {
    const resolvedTabId = tabId ?? ensureActiveChatTab();
    const inTurn = messagesForTab(resolvedTabId).filter((item) => item.turnId === turnId);
    const last = inTurn[inTurn.length - 1];
    if (last) last.endedAt = endedAt;
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

  function clearMessageQueueStatus(messageId: string, tabId?: string) {
    const resolvedTabId = tabId ?? ensureActiveChatTab();
    const message = messagesForTab(resolvedTabId).find((item) => item.id === messageId);
    if (message?.queueStatus) {
      delete message.queueStatus;
    }
  }

  function clearQueuedMessages(tabId?: string) {
    const resolvedTabId = tabId ?? ensureActiveChatTab();
    const tab = tabs.value.find((item) => item.id === resolvedTabId && item.kind === "chat");
    if (!tab) return;
    for (const message of tab.messages) {
      if (message.queueStatus === "queued" || message.queueStatus === "next") {
        delete message.queueStatus;
      }
    }
  }

  function clearAllQueuedMessages() {
    for (const tab of tabs.value) {
      if (tab.kind !== "chat") continue;
      clearQueuedMessages(tab.id);
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

  function updateRunUsage(usage: TokenUsage | null, tabId?: string) {
    const resolvedTabId = tabId ?? ensureActiveChatTab();
    const tab = tabs.value.find((item) => item.id === resolvedTabId && item.kind === "chat");
    if (!tab) return;
    if (usage === null) {
      // Keep last remote context-window occupancy across turns; clear only
      // ephemeral this-run totals so the ring still reflects the session window.
      const prev = tab.runUsage;
      if (!prev) return;
      tab.runUsage = {
        ...prev,
        input_tokens: 0,
        output_tokens: 0,
        total_tokens: 0,
        input: 0,
        output: 0,
        total: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        reasoning_tokens: 0,
        duration_ms: 0,
        ttfb_ms: undefined,
        ttft_ms: undefined,
        turns: 0,
        tool_use_count: 0,
        api_calls: 0,
      };
      return;
    }
    tab.runUsage = usage;
    const total =
      usage.total_tokens ??
      usage.total ??
      (usage.input_tokens ?? usage.input ?? 0) + (usage.output_tokens ?? usage.output ?? 0);
    tab.currentTokenCount = total;
  }

  function setActiveTaskId(taskId: string | null, tabId?: string) {
    const resolvedTabId = tabId ?? ensureActiveChatTab();
    const tab = tabs.value.find((item) => item.id === resolvedTabId && item.kind === "chat");
    if (!tab) return;
    tab.activeTaskId = taskId;
    if (taskId) {
      tab.lastTaskId = taskId;
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
    tab.runUsage = null;
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

  // 默认 tab 的 id 是固定常量，不同窗口/历史会话之间会撞 id。
  // 只有首条消息一致才视为同一段对话，否则历史恢复要另开新 tab。
  function isSameConversation(a: ChatTab, b: ChatTab): boolean {
    const aFirst = a.messages[0]?.id;
    const bFirst = b.messages[0]?.id;
    if (!aFirst || !bFirst) return !aFirst && !bFirst;
    return aFirst === bFirst;
  }

  function openSnapshotTab(snapshot: unknown, tabId?: string): string | null {
    const parsed = parseSnapshot(snapshot);
    if (!parsed) return null;
    const sourceTab =
      (tabId ? parsed.tabs.find((tab) => tab.id === tabId) : null) ??
      parsed.tabs.find((tab) => tab.id === parsed.activeTabId) ??
      parsed.tabs[0];
    if (!sourceTab) return null;

    const existing = tabs.value.find((tab) => tab.id === sourceTab.id);
    if (existing) {
      if (existing.kind === "chat" && isSameConversation(existing, sourceTab)) {
        activeTabId.value = existing.id;
        return existing.id;
      }
      const restored = { ...normalizeChatTab(sourceTab), id: crypto.randomUUID() };
      tabs.value.push(restored);
      activeTabId.value = restored.id;
      return restored.id;
    }

    tabs.value.push(normalizeChatTab(sourceTab));
    activeTabId.value = sourceTab.id;
    return sourceTab.id;
  }

  /** Hydrate / update a chat tab from a PartnerSessionRecord (multi-project sync). */
  function ensureSessionTab(session: {
    id: string;
    title: string;
    messages: Message[];
    lastError?: ChatErrorNotice | null;
    lastTaskId?: string | null;
  }): string {
    const existing = tabs.value.find((tab) => tab.id === session.id);
    if (existing) {
      if (existing.kind !== "chat") return existing.id;
      existing.title = session.title;
      existing.messages = session.messages;
      existing.lastError = session.lastError ?? null;
      existing.lastTaskId = existing.lastTaskId ?? session.lastTaskId ?? null;
      activeTabId.value = existing.id;
      return existing.id;
    }
    tabs.value.push({
      id: session.id,
      title: session.title,
      kind: "chat",
      messages: session.messages,
      isAgentRunning: false,
      lastError: session.lastError ?? null,
      lastTaskId: session.lastTaskId ?? null,
      currentTokenCount: 0,
      estimatedCost: 0,
      runUsage: null,
    });
    activeTabId.value = session.id;
    return session.id;
  }

  /** Align open chat tabs with app-state openTabIds (keeps settings). */
  function syncFromOpenTabIds(
    openTabIds: string[],
    sessions: Record<
      string,
      {
        id: string;
        title: string;
        messages: Message[];
        lastError?: ChatErrorNotice | null;
        lastTaskId?: string | null;
      }
    >,
    nextActiveId: string | null,
  ) {
    const keep = new Set(openTabIds);
    tabs.value = tabs.value.filter((tab) =>
      tab.kind === "settings" ? keep.has(SETTINGS_TAB_ID) : keep.has(tab.id),
    );
    for (const id of openTabIds) {
      if (id === SETTINGS_TAB_ID) {
        if (!tabs.value.some((tab) => tab.id === SETTINGS_TAB_ID)) {
          tabs.value.push(createSettingsTab());
        }
        continue;
      }
      const session = sessions[id];
      if (!session) continue;
      if (!tabs.value.some((tab) => tab.id === id)) {
        tabs.value.push({
          id: session.id,
          title: session.title,
          kind: "chat",
          messages: session.messages,
          isAgentRunning: false,
          lastError: session.lastError ?? null,
          lastTaskId: session.lastTaskId ?? null,
          currentTokenCount: 0,
          estimatedCost: 0,
          runUsage: null,
        });
      }
    }
    if (nextActiveId && tabs.value.some((tab) => tab.id === nextActiveId)) {
      activeTabId.value = nextActiveId;
    } else if (!tabs.value.some((tab) => tab.id === activeTabId.value)) {
      activeTabId.value = tabs.value[0]?.id ?? DEFAULT_CHAT_TAB_ID;
    }
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
    runUsage,
    ensureDefaultChatTab,
    ensureActiveChatTab,
    createChatTab,
    openSettingsTab,
    selectTab,
    closeTab,
    ensureSessionTab,
    syncFromOpenTabIds,
    append,
    appendToolCall,
    appendToolResult,
    updateStreaming,
    finalizeMessage,
    setMessageEndedAt,
    closeTurn,
    markMessageError,
    clearMessageQueueStatus,
    clearQueuedMessages,
    clearAllQueuedMessages,
    setLastError,
    clearLastError,
    messagesForTab,
    setAgentRunning,
    setActiveTaskId,
    updateRunUsage,
    abort,
    clear,
    resetToDefault,
    exportSnapshot,
    exportTabSnapshot,
    restoreSnapshot,
    openSnapshotTab,
  };
});
