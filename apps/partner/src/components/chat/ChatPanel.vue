<script setup lang="ts">
import { storeToRefs } from "pinia";
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { readFile } from "@/bridge";
import { useChatStore } from "@/stores/chat";
import { getOrchestrator } from "@/orchestrator";
import { useSettingsStore } from "@/stores/settings";
import { usePreviewStore } from "@/stores/preview";
import { useWorkspaceStore } from "@/stores/workspace";
import type { ChatAttachment, Message, ToolCall, ToolResult } from "@/types";
import { buildPartnerRunLogPath, formatRunLogPlaceholder } from "@/utils/run-log";
import { formatChatTime, shouldShowChatTime } from "@/utils/chat-time";
import { summarizeToolCall } from "@/utils/tool-progress";
import MessageBubble from "./MessageBubble.vue";
import InputBar from "./InputBar.vue";
import ToolProgressPanel from "./ToolProgressPanel.vue";
import SessionHistoryMenu from "./SessionHistoryMenu.vue";
import SettingsPanel from "@/components/settings/SettingsPanel.vue";

const chat = useChatStore();
const settings = useSettingsStore();
const preview = usePreviewStore();
const workspace = useWorkspaceStore();
const { activeTab, messages, isAgentRunning, lastError, tabs } = storeToRefs(chat);
const orchestrator = getOrchestrator();
const messagesRef = ref<HTMLElement | null>(null);
const shouldStickToBottom = ref(true);

type ChatDisplayItem =
  | { type: "time"; key: string; label: string }
  | { type: "message"; key: string; message: Message }
  | {
      type: "tool-progress";
      key: string;
      timestamp: number;
      toolCalls: ToolCall[];
      toolResults: ToolResult[];
    };

const displayItems = computed<ChatDisplayItem[]>(() => {
  const items: ChatDisplayItem[] = [];
  let activeToolGroup: Extract<ChatDisplayItem, { type: "tool-progress" }> | null = null;
  let lastVisibleTimestamp: number | null = null;

  const appendTimeIfNeeded = (timestamp: number) => {
    if (!shouldShowChatTime(lastVisibleTimestamp, timestamp)) return;
    items.push({
      type: "time",
      key: `time:${timestamp}`,
      label: formatChatTime(timestamp),
    });
  };

  for (const message of messages.value) {
    if (
      message.role === "assistant" &&
      message.isStreaming &&
      !message.content.trim()
    ) {
      continue;
    }

    if (message.role === "tool" && message.toolCalls?.length) {
      if (!activeToolGroup) {
        appendTimeIfNeeded(message.timestamp);
        activeToolGroup = {
          type: "tool-progress",
          key: `tools:${message.id}`,
          timestamp: message.timestamp,
          toolCalls: [],
          toolResults: [],
        };
        items.push(activeToolGroup);
      }
      activeToolGroup.toolCalls.push(...message.toolCalls);
      activeToolGroup.toolResults.push(...(message.toolResults ?? []));
      lastVisibleTimestamp = message.timestamp;
      continue;
    }

    activeToolGroup = null;
    appendTimeIfNeeded(message.timestamp);
    items.push({
      type: "message",
      key: message.id,
      message,
    });
    lastVisibleTimestamp = message.timestamp;
  }

  return items;
});
const activeToolProgressKey = computed(() => {
  for (let index = displayItems.value.length - 1; index >= 0; index -= 1) {
    const item = displayItems.value[index];
    if (item?.type === "tool-progress") return item.key;
  }
  return "";
});

const chatTabCount = computed(() => tabs.value.filter((tab) => tab.kind === "chat").length);
const latestRunningToolCall = computed(() => {
  for (let index = messages.value.length - 1; index >= 0; index -= 1) {
    const message = messages.value[index];
    if (message?.role !== "tool" || !message.toolCalls?.length) continue;
    return message.toolCalls.at(-1) ?? null;
  }
  return null;
});
const runningStatus = computed(() => {
  const toolCall = latestRunningToolCall.value;
  if (!toolCall) return "";
  return summarizeToolCall(toolCall, settings.locale === "zh" ? "zh-CN" : "en-US").detail;
});
const uiText = computed(() => {
  if (settings.locale === "en") {
    return {
      workspaceLabel: "Center workspace",
      settings: "Settings",
      newChat: "New Chat",
      newChatTitle: "New chat",
      running: "Running",
      agentRunning: "Agent running; new messages will queue",
      currentStep: "Running",
      logs: "Logs",
      errorTitle: "Run failed",
      dismiss: "Dismiss",
    };
  }
  return {
    workspaceLabel: "中间工作台",
    settings: "设置",
    newChat: "新对话",
    newChatTitle: "新建对话",
    running: "运行中",
    agentRunning: "Agent 运行中，可继续输入",
    currentStep: "运行中",
    logs: "日志",
    errorTitle: "运行失败",
    dismiss: "关闭",
  };
});

function canCloseTab(tabId: string): boolean {
  const tab = tabs.value.find((item) => item.id === tabId);
  if (!tab || tab.isAgentRunning) return false;
  return tab.kind === "settings" || chatTabCount.value > 1;
}

function createNewChat() {
  chat.createChatTab();
}

function selectTab(tabId: string) {
  chat.selectTab(tabId);
}

function closeTab(tabId: string) {
  chat.closeTab(tabId);
}

function tabTitle(tab: { kind: string; title: string }) {
  return tab.kind === "settings" ? uiText.value.settings : tab.title;
}

function isNearBottom(element: HTMLElement): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight < 80;
}

function onMessagesScroll() {
  const element = messagesRef.value;
  if (!element) return;
  shouldStickToBottom.value = isNearBottom(element);
}

function scrollMessagesToBottom() {
  const element = messagesRef.value;
  if (!element) return;
  element.scrollTop = element.scrollHeight;
}

function scheduleScrollToBottom(force = false) {
  if (!force && !shouldStickToBottom.value) return;
  void nextTick(() => {
    requestAnimationFrame(scrollMessagesToBottom);
  });
}

async function onSubmit(payload: { text: string; attachments: ChatAttachment[] }) {
  shouldStickToBottom.value = true;
  await orchestrator.sendMessage(payload.text, undefined, payload.attachments);
  scheduleScrollToBottom(true);
}

async function openRunLog() {
  if (!workspace.rootPath) {
    preview.openCodeFile("partner-run-log.txt", "尚未选择工作区，无法定位运行日志。\n");
    return;
  }
  const path = buildPartnerRunLogPath(workspace.rootPath);
  try {
    const content = await readFile(path);
    preview.openCodeFile(path, content);
  } catch (error) {
    preview.openCodeFile(path, formatRunLogPlaceholder(path, error));
    console.warn("[ChatPanel] failed to open run log:", error);
  }
}

onMounted(() => {
  chat.ensureDefaultChatTab();
  scheduleScrollToBottom(true);
});

watch(
  () => activeTab.value?.id,
  () => {
    shouldStickToBottom.value = true;
    scheduleScrollToBottom(true);
  },
);

watch(
  () => [
    displayItems.value.length,
    messages.value.at(-1)?.content,
    messages.value.at(-1)?.toolCalls?.length,
    isAgentRunning.value,
  ],
  () => scheduleScrollToBottom(),
  { flush: "post" },
);
</script>

<template>
  <section class="chat-panel" data-shortcut-scope="center">
    <nav class="center-tabs" :aria-label="uiText.workspaceLabel">
      <button
        v-for="tab in tabs"
        :key="tab.id"
        type="button"
        class="center-tab"
        :class="{ active: tab.id === activeTab?.id }"
        @click="selectTab(tab.id)"
      >
        <span class="tab-title">{{ tabTitle(tab) }}</span>
        <span v-if="tab.isAgentRunning" class="running-dot" :aria-label="uiText.running" />
        <span
          v-if="canCloseTab(tab.id)"
          class="tab-close"
          @click.stop="closeTab(tab.id)"
        >
          ×
        </span>
      </button>
      <button
        type="button"
        class="new-chat"
        :title="uiText.newChatTitle"
        :aria-label="uiText.newChatTitle"
        @click="createNewChat"
      >
        <span aria-hidden="true">+</span>
        <span>{{ uiText.newChat }}</span>
      </button>
      <SessionHistoryMenu />
    </nav>

    <div v-if="activeTab?.kind === 'settings'" class="settings-slot">
      <SettingsPanel />
    </div>

    <div v-else class="chat-workspace" :class="{ 'is-empty': !messages.length }">
      <div ref="messagesRef" class="messages" @scroll="onMessagesScroll">
        <template v-for="item in displayItems" :key="item.key">
          <div v-if="item.type === 'time'" class="time-separator">
            {{ item.label }}
          </div>
          <MessageBubble
            v-else-if="item.type === 'message'"
            :message="item.message"
          />
          <ToolProgressPanel
            v-else
            :tool-calls="item.toolCalls"
            :tool-results="item.toolResults"
            :running="isAgentRunning && item.key === activeToolProgressKey"
          />
        </template>
      </div>

      <div class="composer-slot">
        <div v-if="lastError" class="error-status" role="alert">
          <div class="error-copy">
            <strong>{{ uiText.errorTitle }}</strong>
            <span>{{ lastError.message }}</span>
          </div>
          <div class="error-actions">
            <button type="button" class="error-action" @click="openRunLog">
              {{ uiText.logs }}
            </button>
            <button type="button" class="error-action" @click="chat.clearLastError()">
              {{ uiText.dismiss }}
            </button>
          </div>
        </div>
        <div v-if="isAgentRunning" class="live-status">
          <span class="live-dot" aria-hidden="true" />
          <span class="live-label">{{ uiText.currentStep }}</span>
          <span class="live-detail">{{ runningStatus || uiText.agentRunning }}</span>
          <button type="button" class="live-log-button" @click="openRunLog">
            {{ uiText.logs }}
          </button>
        </div>
        <InputBar @submit="onSubmit" />
      </div>
    </div>
  </section>
</template>

<style scoped>
.chat-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-width: 0;
  background: var(--bg);
}

.center-tabs {
  display: flex;
  align-items: center;
  flex-shrink: 0;
  height: 40px;
  padding: 0;
  background: var(--surface);
  overflow-x: auto;
}

.center-tabs :deep(.session-history) {
  margin-left: auto;
}

.center-tab,
.new-chat {
  display: inline-flex;
  align-items: center;
  height: 40px;
  border: none;
  border-radius: 0;
  background: transparent;
  color: var(--text-muted);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}

.center-tab {
  gap: 8px;
  min-width: 88px;
  max-width: 160px;
  padding: 0 10px 0 12px;
  text-align: left;
}

.center-tab:hover,
.new-chat:hover {
  background: color-mix(in srgb, var(--surface-hover) 72%, transparent);
  color: var(--text);
}

.center-tab.active {
  background: var(--surface-elevated);
  color: var(--text);
}

.tab-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tab-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  flex-shrink: 0;
  border-radius: 4px;
  color: var(--text-muted);
}

.tab-close:hover {
  background: var(--surface-hover);
  color: var(--text);
}

.running-dot {
  width: 7px;
  height: 7px;
  flex-shrink: 0;
  border-radius: 999px;
  background: var(--accent);
  animation: pulse 1s infinite;
}

.new-chat {
  gap: 6px;
  justify-content: center;
  width: auto;
  flex-shrink: 0;
  padding: 0 12px;
  font-size: 12px;
}

.settings-slot {
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.chat-workspace {
  flex: 1;
  display: grid;
  grid-template-rows: minmax(0, 1fr) auto minmax(0, 0fr);
  min-height: 0;
  transition: grid-template-rows 280ms cubic-bezier(0.2, 0.8, 0.2, 1);
}

.chat-workspace::after {
  content: "";
  min-height: 0;
}

.chat-workspace.is-empty {
  grid-template-rows: minmax(0, 1fr) auto minmax(0, 1fr);
}

.messages {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-height: 0;
  padding: 16px 16px 10px;
  overflow-y: auto;
  scrollbar-width: thin;
  scrollbar-color: color-mix(in srgb, var(--text-muted) 36%, transparent) transparent;
  transition:
    padding 280ms cubic-bezier(0.2, 0.8, 0.2, 1),
    opacity 160ms ease;
}

.time-separator {
  align-self: center;
  max-width: 80%;
  margin: 4px 0;
  padding: 2px 8px;
  border-radius: 999px;
  color: var(--text-muted);
  background: color-mix(in srgb, var(--surface) 66%, transparent);
  font-size: 12px;
  line-height: 1.6;
}

.messages::-webkit-scrollbar {
  width: 6px;
}

.messages::-webkit-scrollbar-track {
  background: transparent;
}

.messages::-webkit-scrollbar-thumb {
  border-radius: 999px;
  background: color-mix(in srgb, var(--text-muted) 36%, transparent);
}

.messages::-webkit-scrollbar-thumb:hover {
  background: color-mix(in srgb, var(--text-muted) 52%, transparent);
}

.chat-workspace.is-empty .messages {
  padding-block: 0;
  opacity: 0;
  pointer-events: none;
}

.composer-slot {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-inline: 12px;
}

.error-status {
  align-self: center;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  width: min(760px, calc(100% - 24px));
  margin: 0 auto 2px;
  padding: 10px 12px;
  border: 1px solid color-mix(in srgb, #ff6b6b 58%, var(--border));
  border-radius: 12px;
  background: color-mix(in srgb, #ff6b6b 10%, var(--surface-elevated));
  color: var(--text);
  box-shadow:
    0 8px 22px rgba(0, 0, 0, 0.18),
    inset 0 1px 0 color-mix(in srgb, #fff 5%, transparent);
}

.error-copy {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  line-height: 1.45;
}

.error-copy strong {
  color: #ff8a8a;
  font-size: 13px;
}

.error-copy span {
  display: -webkit-box;
  overflow: hidden;
  color: color-mix(in srgb, var(--text) 86%, transparent);
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  white-space: pre-wrap;
}

.error-actions {
  display: flex;
  flex-shrink: 0;
  gap: 6px;
}

.error-action {
  height: 24px;
  border: none;
  border-radius: 999px;
  padding: 0 8px;
  background: color-mix(in srgb, var(--surface-hover) 76%, transparent);
  color: var(--text-muted);
  font: inherit;
  font-size: 11px;
  cursor: pointer;
}

.error-action:hover {
  color: var(--text);
  background: var(--surface-hover);
}

.live-status {
  align-self: center;
  display: flex;
  align-items: center;
  gap: 7px;
  max-width: min(560px, calc(100% - 24px));
  margin: 0 auto -2px;
  padding: 5px 9px;
  border: 1px solid color-mix(in srgb, var(--border) 70%, transparent);
  border-radius: 999px;
  background: color-mix(in srgb, var(--surface-elevated) 68%, transparent);
  color: var(--text-muted);
  font-size: 11px;
  box-shadow:
    0 8px 22px rgba(0, 0, 0, 0.18),
    inset 0 1px 0 color-mix(in srgb, #fff 5%, transparent);
  backdrop-filter: blur(8px);
}

.live-dot {
  width: 6px;
  height: 6px;
  flex-shrink: 0;
  border-radius: 999px;
  background: var(--accent);
  animation: pulse 1s infinite;
}

.live-label {
  flex-shrink: 0;
  color: color-mix(in srgb, var(--text) 72%, transparent);
}

.live-label::after {
  content: "·";
  margin-left: 7px;
  color: var(--text-muted);
}

.live-detail {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.live-log-button {
  flex-shrink: 0;
  height: 20px;
  border: none;
  border-radius: 999px;
  padding: 0 7px;
  background: color-mix(in srgb, var(--surface-hover) 68%, transparent);
  color: var(--text-muted);
  font: inherit;
  font-size: 11px;
  cursor: pointer;
}

.live-log-button:hover {
  color: var(--text);
  background: var(--surface-hover);
}

@keyframes pulse {
  50% {
    opacity: 0.35;
  }
}
</style>
