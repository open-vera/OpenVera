<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useAppStateStore } from "@/stores/app-state";
import { useChatStore } from "@/stores/chat";
import { formatChatTime } from "@/utils/chat-time";
import type { Message } from "@/types";

interface HistoryEntry {
  key: string;
  sessionId: string;
  title: string;
  preview: string;
  updatedAt: number;
}

const chat = useChatStore();
const appState = useAppStateStore();
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

function lastMessage(messages: Message[]): Message | undefined {
  return [...messages].reverse().find((message) => message.content.trim());
}

async function refreshHistory() {
  loading.value = true;
  error.value = "";
  try {
    if (!appState.isLoaded) await appState.load();
    entries.value = Object.values(appState.sessions)
      .map((session) => {
        const message = lastMessage(session.messages);
        return {
          key: session.id,
          sessionId: session.id,
          title: session.title.trim() || "未命名会话",
          preview: message?.content.trim().replace(/\s+/g, " ").slice(0, 80) || "空会话",
          updatedAt: session.updatedAt,
        };
      })
      .sort((a, b) => b.updatedAt - a.updatedAt);
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
  const left = Math.max(
    rightPadding,
    Math.min(rect.right - width, window.innerWidth - width - rightPadding),
  );
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
  appState.selectTab(entry.sessionId);
  const session = appState.getSession(entry.sessionId);
  if (session) chat.ensureSessionTab(session);
  open.value = false;
}

function onPointerDown(event: PointerEvent) {
  const target = event.target as Node | null;
  if (!open.value || !target) return;
  if (buttonRef.value?.contains(target)) return;
  const popover = document.querySelector(".session-history-popover");
  if (popover?.contains(target)) return;
  open.value = false;
}

onMounted(() => {
  window.addEventListener("pointerdown", onPointerDown, true);
});

onBeforeUnmount(() => {
  window.removeEventListener("pointerdown", onPointerDown, true);
});
</script>

<template>
  <div class="session-history">
    <button
      ref="buttonRef"
      type="button"
      class="history-button"
      :title="uiText.historyTitle"
      :aria-label="uiText.historyTitle"
      :aria-expanded="open"
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
        class="session-history-popover"
        :style="popoverStyle"
      >
        <div class="popover-title">{{ uiText.historyTitle }}</div>
        <div v-if="loading" class="popover-empty">{{ uiText.loading }}</div>
        <div v-else-if="error" class="popover-empty">{{ error }}</div>
        <div v-else-if="entries.length === 0" class="popover-empty">{{ uiText.empty }}</div>
        <button
          v-for="entry in entries"
          :key="entry.key"
          type="button"
          class="history-item"
          @click="selectEntry(entry)"
        >
          <span class="history-item-title">{{ entry.title }}</span>
          <span class="history-item-preview">{{ entry.preview }}</span>
          <span class="history-item-time">{{ formatChatTime(entry.updatedAt) }}</span>
        </button>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.session-history {
  position: relative;
}
.history-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border: none;
  border-radius: 6px;
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
.session-history-popover {
  position: fixed;
  z-index: 80;
  width: 320px;
  max-height: 360px;
  overflow: auto;
  border: 1px solid var(--border);
  border-radius: 10px;
  /* Solid surface: the glass/wallpaper `--bg` let the file tree bleed through. */
  background: var(--surface-elevated-solid, var(--surface-elevated));
  -webkit-backdrop-filter: none;
  backdrop-filter: none;
  box-shadow: 0 12px 40px color-mix(in srgb, #000 40%, transparent);
  padding: 8px;
}
.popover-title {
  font-size: 12px;
  color: var(--text-secondary);
  padding: 4px 6px 8px;
}
.popover-empty {
  padding: 16px 8px;
  color: var(--text-muted);
  font-size: 12px;
}
.history-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
  width: 100%;
  border: none;
  background: transparent;
  text-align: left;
  padding: 8px;
  border-radius: 8px;
  cursor: pointer;
  color: var(--text);
  transition: background 120ms ease;
}
.history-item:hover,
.history-item:focus-visible {
  background: var(--surface-hover-solid, var(--surface-hover));
  outline: none;
}
.history-item-title {
  font-size: 13px;
  font-weight: 600;
}
.history-item-preview {
  font-size: 12px;
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.history-item-time {
  font-size: 11px;
  color: var(--text-muted);
}
</style>
