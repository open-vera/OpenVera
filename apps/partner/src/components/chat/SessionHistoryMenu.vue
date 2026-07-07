<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { loadPartnerSessions } from "@/bridge";
import { useChatStore } from "@/stores/chat";
import { usePreviewStore } from "@/stores/preview";
import { useSessionStore } from "@/stores/session";
import { useWorkspaceStore } from "@/stores/workspace";
import { formatChatTime } from "@/utils/chat-time";
import {
  normalizePartnerSessions,
  type PartnerTaskSnapshot,
  type PartnerWindowSnapshot,
} from "@/utils/partner-sessions";
import type { ChatTab, Message } from "@/types";

interface HistoryEntry {
  key: string;
  windowId: string;
  tabId: string;
  title: string;
  preview: string;
  updatedAt: number;
  taskSnapshot?: PartnerTaskSnapshot;
  windowSnapshot?: PartnerWindowSnapshot;
}

const chat = useChatStore();
const previewStore = usePreviewStore();
const session = useSessionStore();
const workspace = useWorkspaceStore();
const open = ref(false);
const loading = ref(false);
const error = ref("");
const entries = ref<HistoryEntry[]>([]);
const buttonRef = ref<HTMLButtonElement | null>(null);
const popoverStyle = ref<Record<string, string>>({});

const uiText = computed(() => ({
  history: "历史",
  historyTitle: "会话历史",
  loading: "加载中…",
  empty: "暂无历史会话",
}));

function lastMessage(tab: ChatTab): Message | undefined {
  return [...tab.messages].reverse().find((message) => message.content.trim());
}

function entryPreview(tab: ChatTab): string {
  const message = lastMessage(tab);
  if (!message) return "空会话";
  return message.content.trim().replace(/\s+/g, " ").slice(0, 80);
}

function entryUpdatedAt(tab: ChatTab, fallback: number): number {
  return lastMessage(tab)?.timestamp ?? fallback;
}

function currentWindowSnapshot(): PartnerWindowSnapshot {
  return {
    windowId: session.current.windowId,
    chat: chat.exportSnapshot(),
    preview: previewStore.exportSnapshot(),
    layout: { leftWidth: 240, previewWidth: 420 },
    updatedAt: Date.now(),
  };
}

function buildEntries(snapshot: unknown): HistoryEntry[] {
  const normalized = normalizePartnerSessions(snapshot);
  normalized.windows[session.current.windowId] = currentWindowSnapshot();
  const taskEntries = Object.values(normalized.tasks)
    .map((task) => ({
      key: `task:${task.taskId}`,
      windowId: task.windowId,
      tabId: task.chatTabId,
      title: task.title,
      preview: task.previewText || "空会话",
      updatedAt: task.updatedAt,
      taskSnapshot: task,
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt);

  const windowEntries = Object.values(normalized.windows)
    .flatMap((windowSnapshot) =>
      windowSnapshot.chat.tabs
        .filter((tab) => tab.kind === "chat")
        .map((tab) => ({
          key: `${windowSnapshot.windowId}:${tab.id}`,
          windowId: windowSnapshot.windowId,
          tabId: tab.id,
          title: tab.title,
          preview: entryPreview(tab),
          updatedAt: entryUpdatedAt(tab, windowSnapshot.updatedAt),
          windowSnapshot,
        })),
    )
    .sort((a, b) => b.updatedAt - a.updatedAt);

  return [...taskEntries, ...windowEntries].sort((a, b) => b.updatedAt - a.updatedAt);
}

async function refreshHistory() {
  if (!workspace.rootPath) {
    entries.value = [];
    return;
  }
  loading.value = true;
  error.value = "";
  try {
    entries.value = buildEntries(await loadPartnerSessions(workspace.rootPath));
  } catch (historyError) {
    error.value = historyError instanceof Error ? historyError.message : String(historyError);
    entries.value = [];
  } finally {
    loading.value = false;
  }
}

function updatePopoverPosition() {
  const rect = buttonRef.value?.getBoundingClientRect();
  if (!rect) return;
  const width = 320;
  const rightPadding = 10;
  const left = Math.max(rightPadding, Math.min(rect.right - width, window.innerWidth - width - rightPadding));
  popoverStyle.value = {
    top: `${rect.bottom + 4}px`,
    left: `${left}px`,
  };
}

async function toggleOpen() {
  open.value = !open.value;
  if (open.value) {
    updatePopoverPosition();
    await refreshHistory();
    updatePopoverPosition();
  }
}

function selectEntry(entry: HistoryEntry) {
  let openedTabId: string | null = null;
  if (entry.taskSnapshot) {
    openedTabId = chat.openSnapshotTab(entry.taskSnapshot.chat, entry.tabId);
    previewStore.restoreSnapshot(entry.taskSnapshot.preview);
  } else if (entry.windowSnapshot) {
    openedTabId = chat.openSnapshotTab(entry.windowSnapshot.chat, entry.tabId);
    if (entry.windowId !== session.current.windowId) {
      previewStore.restoreSnapshot(entry.windowSnapshot.preview);
    }
  }
  chat.selectTab(openedTabId ?? entry.tabId);
  open.value = false;
}

function closeOnOutsideClick(event: MouseEvent) {
  const target = event.target;
  if (!(target instanceof Element) || !target.closest("[data-session-history-menu]")) {
    open.value = false;
  }
}

onMounted(() => {
  window.addEventListener("click", closeOnOutsideClick);
  window.addEventListener("resize", updatePopoverPosition);
});

onBeforeUnmount(() => {
  window.removeEventListener("click", closeOnOutsideClick);
  window.removeEventListener("resize", updatePopoverPosition);
});
</script>

<template>
  <div class="session-history" data-session-history-menu>
    <button
      ref="buttonRef"
      type="button"
      class="history-button"
      :title="uiText.historyTitle"
      :aria-label="uiText.historyTitle"
      @click.stop="toggleOpen"
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M4 12a8 8 0 1 0 2.35-5.65" />
        <path d="M4 4v5h5" />
        <path d="M12 7v5l3 2" />
      </svg>
    </button>
    <Teleport to="body">
      <div
        v-if="open"
        class="history-popover"
        :style="popoverStyle"
        data-session-history-menu
        @click.stop
      >
        <div v-if="loading" class="history-empty">{{ uiText.loading }}</div>
        <div v-else-if="error" class="history-empty error">{{ error }}</div>
        <div v-else-if="entries.length === 0" class="history-empty">{{ uiText.empty }}</div>
        <template v-else>
          <button
            v-for="entry in entries"
            :key="entry.key"
            type="button"
            class="history-item"
            @click="selectEntry(entry)"
          >
            <span class="history-title">{{ entry.title }}</span>
            <span class="history-meta">{{ formatChatTime(entry.updatedAt) }}</span>
            <span class="history-preview">{{ entry.preview }}</span>
          </button>
        </template>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.session-history {
  position: relative;
  flex-shrink: 0;
}

.history-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  border: none;
  padding: 0;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
}

.history-button:hover {
  background: color-mix(in srgb, var(--surface-hover) 72%, transparent);
  color: var(--text);
}

.history-button svg {
  width: 18px;
  height: 18px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.8;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.history-popover {
  position: fixed;
  z-index: 1000;
  width: 320px;
  max-height: min(420px, 70vh);
  padding: 6px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface-elevated);
  box-shadow: 0 16px 38px rgb(0 0 0 / 38%);
  overflow-y: auto;
}

.history-empty {
  padding: 12px;
  color: var(--text-muted);
  font-size: 12px;
}

.history-empty.error {
  color: #ff8a8a;
}

.history-item {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 3px 8px;
  width: 100%;
  border: none;
  border-radius: 8px;
  padding: 8px;
  background: transparent;
  color: var(--text);
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.history-item:hover {
  background: var(--surface-hover);
}

.history-title,
.history-preview {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.history-title {
  font-size: 13px;
  font-weight: 600;
}

.history-meta {
  color: var(--text-muted);
  font-size: 11px;
}

.history-preview {
  grid-column: 1 / -1;
  color: var(--text-muted);
  font-size: 12px;
}
</style>
