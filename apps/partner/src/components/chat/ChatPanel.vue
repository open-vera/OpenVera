<script setup lang="ts">
import { storeToRefs } from "pinia";
import { computed, nextTick, onMounted, ref, watch, type ComponentPublicInstance } from "vue";
import { readRunLog, type RunLogView } from "@/bridge";
import { measureAsync } from "@/perf";
import { useChatStore } from "@/stores/chat";
import { getChatRunner } from "@/shell";
import { useSettingsStore } from "@/stores/settings";
import { usePreviewStore } from "@/stores/preview";
import { useWorkspaceStore } from "@/stores/workspace";
import type { ChatAttachment } from "@/types";
import {
  closeCenterTabById,
  confirmQuitPartner,
} from "@/utils/close-center-tab";
import {
  formatRunLogPlaceholder,
  formatRunLogReadFailure,
  formatRunLogTruncationNotice,
} from "@/utils/run-log";
import {
  buildChatDisplayItems,
  buildChatTimelineEntries,
  hasVisibleToolProgress,
  type ChatDisplayItem,
  type ChatTimelineEntry,
} from "@/utils/chat-timeline";
import MessageAnchorRail from "./MessageAnchorRail.vue";
import InputBar from "./InputBar.vue";
import ChatTimelineItem from "./ChatTimelineItem.vue";
import TurnTimeline from "./TurnTimeline.vue";
import SettingsPanel from "@/components/settings/SettingsPanel.vue";
import { useAppStateStore } from "@/stores/app-state";
import { buildUserMessageAnchors } from "@/utils/message-anchors";
import { scrollTabIntoView } from "@/utils/scroll-tab-into-view";

const chat = useChatStore();
const settings = useSettingsStore();
const preview = usePreviewStore();
const workspace = useWorkspaceStore();
const appState = useAppStateStore();
const { activeTab, messages, isAgentRunning, tabs, runUsage } = storeToRefs(chat);
const chatRunner = getChatRunner();
const messagesRef = ref<HTMLElement | null>(null);
const tabsScrollRef = ref<HTMLElement | null>(null);
const inputBarRef = ref<InstanceType<typeof InputBar> | null>(null);
const shouldStickToBottom = ref(true);
const itemElements = new Map<string, HTMLElement>();

const displayLocale = computed<"zh-CN" | "en-US">(() =>
  settings.locale === "zh" ? "zh-CN" : "en-US",
);

const allDisplayItems = computed<ChatDisplayItem[]>(() =>
  buildChatDisplayItems(messages.value),
);

const displayItems = computed<ChatDisplayItem[]>(() => {
  if (!isAgentRunning.value) return allDisplayItems.value;

  return allDisplayItems.value.filter(
    (item) =>
      item.type !== "tool-progress" ||
      hasVisibleToolProgress(item.toolCalls, displayLocale.value),
  );
});

const timelineEntries = computed<ChatTimelineEntry[]>(() =>
  buildChatTimelineEntries(displayItems.value),
);

/** The turn the agent is currently working on — the last one, while running. */
const runningTurnKey = computed(() => {
  if (!isAgentRunning.value) return "";
  for (let index = timelineEntries.value.length - 1; index >= 0; index -= 1) {
    const entry = timelineEntries.value[index];
    if (entry?.type === "turn") return entry.key;
  }
  return "";
});

const activeToolProgressKey = computed(() => {
  for (let index = displayItems.value.length - 1; index >= 0; index -= 1) {
    const item = displayItems.value[index];
    if (item?.type === "tool-progress") return item.key;
  }
  return "";
});

const uiText = computed(() => {
  if (settings.locale === "en") {
    return {
      workspaceLabel: "Center workspace",
      settings: "Settings",
      newChat: "New Chat",
      newChatTitle: "New chat",
      running: "Running",
    };
  }
  return {
    workspaceLabel: "中间工作台",
    settings: "设置",
    newChat: "新对话",
    newChatTitle: "新建对话",
    running: "运行中",
  };
});

function createNewChat() {
  const id = appState.createSession({ projectId: appState.previewProjectId });
  const session = appState.getSession(id);
  if (session) chat.ensureSessionTab(session);
  focusInputBar();
}

function selectTab(tabId: string) {
  appState.selectTab(tabId);
  if (tabId === "settings") {
    chat.openSettingsTab();
  } else {
    const session = appState.getSession(tabId);
    if (session) chat.ensureSessionTab(session);
    else chat.selectTab(tabId);
  }
  focusInputBar();
}

function closeTab(tabId: string) {
  void (async () => {
    if (tabs.value.length <= 1 && tabs.value[0]?.id === tabId) {
      await confirmQuitPartner();
      return;
    }
    closeCenterTabById(tabId);
  })();
}

function abortActiveRun() {
  chatRunner.abort();
}

function promoteQueuedMessage(_messageId: string) {
  // Queue order is owned by Host; no client-side promote.
}

function runQueuedMessageNow(_messageId: string) {
  // Queue order is owned by Host; no client-side jump.
}

function tabTitle(tab: { kind: string; title: string }) {
  return tab.kind === "settings" ? uiText.value.settings : tab.title;
}

function focusInputBar() {
  void nextTick(() => {
    inputBarRef.value?.focus();
  });
}

function scrollActiveCenterTabIntoView() {
  scrollTabIntoView(tabsScrollRef.value, activeTab.value?.id ?? null, {
    behavior: "smooth",
  });
}

function setItemElement(key: string, element: Element | ComponentPublicInstance | null) {
  if (element instanceof HTMLElement) {
    itemElements.set(key, element);
  } else {
    itemElements.delete(key);
  }
}

function itemKeyForMessageId(messageId: string): string {
  const message = messages.value.find((item) => item.id === messageId);
  if (!message) return messageId;
  // Messages inside a turn are rendered by TurnTimeline (and may be collapsed),
  // so anchor on the turn container instead.
  if (message.turnId) return `turn:${message.turnId}`;
  if (message.role !== "tool") return message.id;
  return displayItems.value.find(
    (item) => item.type === "tool-progress" && item.messageIds.includes(messageId),
  )?.key ?? `tools:${message.id}`;
}

function jumpToMessage(messageId: string) {
  shouldStickToBottom.value = false;
  void nextTick(() => {
    requestAnimationFrame(() => {
      const element = itemElements.get(itemKeyForMessageId(messageId));
      element?.scrollIntoView({ behavior: "smooth", block: "center" });
      element?.classList.add("search-jump-highlight");
      window.setTimeout(() => {
        element?.classList.remove("search-jump-highlight");
      }, 1400);
    });
  });
}

const userMessageAnchors = computed(() => buildUserMessageAnchors(messages.value));

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
  await chatRunner.sendMessage(payload.text, undefined, payload.attachments);
  scheduleScrollToBottom(true);
}

const RUN_LOG_OPEN_MAX_BYTES = 400_000;

async function openRunLog() {
  await measureAsync(
    "openRunLog",
    async () => {
      if (!workspace.rootPath) {
        preview.openCodeFile("partner-run-log.txt", "尚未选择工作区，无法定位运行日志。\n");
        return;
      }
      const taskId = activeTab.value?.kind === "chat"
        ? activeTab.value.activeTaskId ?? activeTab.value.lastTaskId
        : null;
      let view: RunLogView;
      try {
        view = await readRunLog(workspace.rootPath, taskId, RUN_LOG_OPEN_MAX_BYTES);
      } catch (error) {
        const label = `${workspace.rootPath} (task: ${taskId ?? "未知"})`;
        preview.openCodeFile("partner-run-log.txt", formatRunLogReadFailure(label, error));
        console.warn("[ChatPanel] failed to open run log:", error);
        return;
      }
      if (!view.exists) {
        preview.openCodeFile(view.path, formatRunLogPlaceholder(view.path));
        return;
      }
      preview.openCodeFile(
        view.path,
        view.truncated
          ? [
              formatRunLogTruncationNotice(view.path, view.content.length, view.totalBytes),
              view.content,
            ].join("\n")
          : view.content,
      );
    },
    { warnMs: 100, errorMs: 800, timeoutMs: 15_000 },
  );
}

defineExpose({ jumpToMessage });

onMounted(() => {
  // Default session is seeded by App via app-state sync (avoid dual default tabs).
  scheduleScrollToBottom(true);
  focusInputBar();
});

watch(
  () => activeTab.value?.id,
  () => {
    itemElements.clear();
    shouldStickToBottom.value = true;
    scheduleScrollToBottom(true);
    focusInputBar();
    void nextTick(() => {
      requestAnimationFrame(scrollActiveCenterTabIntoView);
    });
  },
);

watch(
  () => tabs.value.length,
  () => {
    void nextTick(() => {
      requestAnimationFrame(scrollActiveCenterTabIntoView);
    });
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
  <section class="chat-panel" data-shortcut-scope="center" data-chat-drop>
    <nav class="center-tabs" :aria-label="uiText.workspaceLabel">
      <div ref="tabsScrollRef" class="center-tabs-scroll">
        <button
          v-for="tab in tabs"
          :key="tab.id"
          type="button"
          class="center-tab"
          :data-tab-id="tab.id"
          :class="{
            active: tab.id === activeTab?.id,
            settings: tab.kind === 'settings',
          }"
          @click="selectTab(tab.id)"
        >
          <svg
            v-if="tab.kind === 'settings'"
            class="tab-icon"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <circle cx="12" cy="12" r="3" />
            <path
              d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9c.26.604.852.997 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"
            />
          </svg>
          <span class="tab-title">{{ tabTitle(tab) }}</span>
          <span v-if="tab.isAgentRunning" class="running-dot" :aria-label="uiText.running" />
          <span class="tab-close" @click.stop="closeTab(tab.id)">×</span>
        </button>
      </div>
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
    </nav>

    <div v-if="activeTab?.kind === 'settings'" class="settings-slot">
      <SettingsPanel />
    </div>

    <div v-else class="chat-workspace" :class="{ 'is-empty': !messages.length }">
      <div class="messages-shell">
        <div ref="messagesRef" class="messages" @scroll="onMessagesScroll">
          <template v-for="entry in timelineEntries" :key="entry.key">
            <div
              v-if="entry.type === 'item'"
              :ref="(element) => setItemElement(entry.key, element)"
              class="message-anchor"
            >
              <ChatTimelineItem
                :item="entry.item"
                :running="isAgentRunning && entry.key === activeToolProgressKey"
                :usage="entry.key === activeToolProgressKey ? runUsage : null"
                @promote-queued="promoteQueuedMessage"
                @run-queued-now="runQueuedMessageNow"
                @open-logs="openRunLog"
              />
            </div>
            <div
              v-else
              :ref="(element) => setItemElement(entry.key, element)"
              class="message-anchor"
            >
              <TurnTimeline
                :turn="entry"
                :running="entry.key === runningTurnKey"
                :usage="entry.key === runningTurnKey ? runUsage : null"
                :locale="displayLocale"
                @promote-queued="promoteQueuedMessage"
                @run-queued-now="runQueuedMessageNow"
                @open-logs="openRunLog"
              />
            </div>
          </template>
        </div>
        <MessageAnchorRail
          :anchors="userMessageAnchors"
          @select="jumpToMessage"
        />
      </div>

      <div class="composer-slot">
        <InputBar
          ref="inputBarRef"
          :running="isAgentRunning"
          :usage="runUsage"
          @submit="onSubmit"
          @abort="abortActiveRun"
        />
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
  align-items: stretch;
  flex-shrink: 0;
  min-width: 0;
  height: 36px;
  padding: 0;
  border-bottom: 1px solid var(--border);
  background: var(--bg);
}

.center-tabs-scroll {
  display: flex;
  align-items: stretch;
  flex: 1;
  min-width: 0;
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: none;
}

.center-tabs-scroll::-webkit-scrollbar {
  display: none;
}

.center-tab,
.new-chat {
  position: relative;
  display: inline-flex;
  align-items: center;
  align-self: stretch;
  height: auto;
  border: none;
  border-radius: 0;
  background: transparent;
  color: var(--text-muted);
  font: inherit;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
}

.center-tab {
  gap: 6px;
  min-width: 72px;
  max-width: 160px;
  padding: 0 10px;
  text-align: left;
}

.center-tab:hover,
.new-chat:hover {
  background: color-mix(
    in srgb,
    var(--surface-hover-solid, var(--surface-hover)) 78%,
    transparent
  );
  color: var(--text);
}

.center-tab:hover::before,
.new-chat:hover::before {
  content: "";
  position: absolute;
  right: 8px;
  bottom: 0;
  left: 8px;
  z-index: 1;
  height: 2px;
  background: color-mix(in srgb, var(--text-muted) 55%, transparent);
}

.center-tab.active {
  background: transparent;
  color: var(--text);
  font-weight: 600;
}

.center-tab.active:hover {
  background: color-mix(
    in srgb,
    var(--surface-hover-solid, var(--surface-hover)) 55%,
    transparent
  );
}

.center-tab.active:hover::before {
  display: none;
}

/* GitHub UnderlineNav: indicator sits on the tab bar border */
.center-tab.active::after {
  content: "";
  position: absolute;
  right: 8px;
  bottom: 0;
  left: 8px;
  z-index: 1;
  height: 2px;
  border-radius: 0;
  background: var(--tab-indicator, var(--accent));
}

.tab-icon {
  flex-shrink: 0;
  width: 14px;
  height: 14px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.7;
  stroke-linecap: round;
  stroke-linejoin: round;
  opacity: 0.9;
}

.center-tab.settings .tab-title {
  flex: 0 1 auto;
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
  width: 20px;
  height: 20px;
  flex-shrink: 0;
  border-radius: 5px;
  color: var(--text-muted);
  font-size: 15px;
  line-height: 1;
  opacity: 0;
  pointer-events: none;
}

.center-tab:hover .tab-close,
.center-tab.active .tab-close {
  opacity: 1;
  pointer-events: auto;
}

.tab-close:hover {
  background: var(--surface-hover);
  color: var(--text);
}

.running-dot {
  width: 6px;
  height: 6px;
  flex-shrink: 0;
  border-radius: 999px;
  background: var(--accent);
  animation: pulse 1s infinite;
}

.new-chat {
  gap: 4px;
  justify-content: center;
  flex-shrink: 0;
  padding: 0 12px;
}

.settings-slot {
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.chat-workspace {
  /* Same column as InputBar composer-card (920px). Keep room for the left anchor rail. */
  --chat-column-max: 920px;
  --chat-side-pad: max(32px, calc((100% - var(--chat-column-max)) / 2));
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
  min-width: 0;
}

.messages-shell {
  position: relative;
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  min-height: 0;
  min-width: 0;
  overflow: hidden;
}

.messages {
  /* Fill the shared chat column; side pad handles centering vs input. */
  --chat-assistant-width: 100%;
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 12px;
  min-height: 0;
  padding: 16px var(--chat-side-pad) 10px;
  overflow-y: auto;
  transition:
    padding 280ms cubic-bezier(0.2, 0.8, 0.2, 1),
    opacity 160ms ease;
}

.message-anchor {
  display: flex;
  flex-direction: column;
  width: 100%;
}

.message-anchor.search-jump-highlight :deep(.bubble),
.message-anchor.search-jump-highlight :deep(.tool-progress) {
  outline: 2px solid color-mix(in srgb, var(--accent) 64%, transparent);
  outline-offset: 4px;
  border-radius: 12px;
}

.chat-workspace.is-empty .messages {
  padding-block: 0;
  opacity: 0;
  pointer-events: none;
}

.chat-workspace.is-empty :deep(.message-anchor-rail) {
  display: none;
}

.composer-slot {
  flex: 0 0 auto;
  min-width: 0;
  margin-top: auto;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-inline: var(--chat-side-pad);
}

@keyframes pulse {
  50% {
    opacity: 0.35;
  }
}
</style>
