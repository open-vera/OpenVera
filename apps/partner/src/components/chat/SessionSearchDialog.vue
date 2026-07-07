<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
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

interface SearchSource {
  key: string;
  windowId: string;
  tabId: string;
  title: string;
  updatedAt: number;
  messages: Message[];
  taskSnapshot?: PartnerTaskSnapshot;
  windowSnapshot?: PartnerWindowSnapshot;
}

interface SearchResult {
  key: string;
  source: SearchSource;
  message: Message;
  excerpt: string;
}

const emit = defineEmits<{
  select: [messageId: string];
}>();

const chat = useChatStore();
const previewStore = usePreviewStore();
const session = useSessionStore();
const workspace = useWorkspaceStore();
const open = ref(false);
const loading = ref(false);
const error = ref("");
const query = ref("");
const sources = ref<SearchSource[]>([]);
const buttonRef = ref<HTMLButtonElement | null>(null);
const searchInputRef = ref<HTMLInputElement | null>(null);

const uiText = {
  search: "搜索",
  title: "搜索会话",
  placeholder: "搜索不同会话中的用户、模型和工具内容",
  loading: "加载中…",
  empty: "输入关键词搜索会话内容",
  noResults: "没有找到结果",
  close: "关闭",
};

function lastMessage(tab: ChatTab): Message | undefined {
  return [...tab.messages].reverse().find((message) => message.content.trim());
}

function sourceUpdatedAt(tab: ChatTab, fallback: number): number {
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

function tabTitle(tab: ChatTab, fallback: string): string {
  return tab.title.trim() || fallback;
}

function buildSources(snapshot: unknown): SearchSource[] {
  const normalized = normalizePartnerSessions(snapshot);
  normalized.windows[session.current.windowId] = currentWindowSnapshot();
  const taskSources = Object.values(normalized.tasks).flatMap((task) =>
    task.chat.tabs
      .filter((tab) => tab.kind === "chat")
      .map((tab) => ({
        key: `task:${task.taskId}:${tab.id}`,
        windowId: task.windowId,
        tabId: tab.id,
        title: task.title || tabTitle(tab, "未命名任务"),
        updatedAt: task.updatedAt,
        messages: tab.messages,
        taskSnapshot: task,
      })),
  );
  const windowSources = Object.values(normalized.windows).flatMap((windowSnapshot) =>
    windowSnapshot.chat.tabs
      .filter((tab) => tab.kind === "chat")
      .map((tab) => ({
        key: `window:${windowSnapshot.windowId}:${tab.id}`,
        windowId: windowSnapshot.windowId,
        tabId: tab.id,
        title: tabTitle(tab, "未命名会话"),
        updatedAt: sourceUpdatedAt(tab, windowSnapshot.updatedAt),
        messages: tab.messages,
        windowSnapshot,
      })),
  );
  const unique = new Map<string, SearchSource>();
  for (const source of [...taskSources, ...windowSources].sort((a, b) => b.updatedAt - a.updatedAt)) {
    const firstMessageId = source.messages[0]?.id ?? "";
    const key = `${source.windowId}:${source.tabId}:${firstMessageId}`;
    if (!unique.has(key)) unique.set(key, source);
  }
  return [...unique.values()];
}

function messageSearchText(message: Message): string {
  const toolCalls = message.toolCalls
    ?.map((toolCall) => `${toolCall.name} ${JSON.stringify(toolCall.input)}`)
    .join("\n") ?? "";
  const toolResults = message.toolResults
    ?.map((result) => result.output)
    .join("\n") ?? "";
  const attachments = message.attachments
    ?.map((attachment) => `${attachment.name} ${attachment.content ?? ""}`)
    .join("\n") ?? "";
  return [message.content, message.agentContent, toolCalls, toolResults, attachments]
    .filter(Boolean)
    .join("\n");
}

function roleLabel(role: Message["role"]): string {
  if (role === "user") return "用户";
  if (role === "assistant") return "模型";
  return "工具";
}

function excerptFor(text: string, search: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return "空消息";
  const index = normalized.toLowerCase().indexOf(search.toLowerCase());
  const start = index >= 0 ? Math.max(0, index - 44) : 0;
  const excerpt = normalized.slice(start, start + 150);
  return `${start > 0 ? "…" : ""}${excerpt}${start + 150 < normalized.length ? "…" : ""}`;
}

const normalizedQuery = computed(() => query.value.trim().toLowerCase());
const results = computed<SearchResult[]>(() => {
  const search = normalizedQuery.value;
  if (!search) return [];
  return sources.value.flatMap((source) =>
    source.messages
      .filter((message) => messageSearchText(message).toLowerCase().includes(search))
      .map((message) => ({
        key: `${source.key}:${message.id}`,
        source,
        message,
        excerpt: excerptFor(messageSearchText(message), search),
      })),
  );
});

async function refreshSources() {
  if (!workspace.rootPath) {
    sources.value = buildSources(null);
    return;
  }
  loading.value = true;
  error.value = "";
  try {
    sources.value = buildSources(await loadPartnerSessions(workspace.rootPath));
  } catch (searchError) {
    error.value = searchError instanceof Error ? searchError.message : String(searchError);
    sources.value = buildSources(null);
  } finally {
    loading.value = false;
  }
}

async function openDialog() {
  open.value = true;
  await refreshSources();
  await nextTick();
  searchInputRef.value?.focus();
}

function closeDialog() {
  open.value = false;
}

function selectResult(result: SearchResult) {
  let openedTabId: string | null = null;
  if (result.source.taskSnapshot) {
    openedTabId = chat.openSnapshotTab(result.source.taskSnapshot.chat, result.source.tabId);
    previewStore.restoreSnapshot(result.source.taskSnapshot.preview);
  } else if (result.source.windowSnapshot) {
    openedTabId = chat.openSnapshotTab(result.source.windowSnapshot.chat, result.source.tabId);
    if (result.source.windowId !== session.current.windowId) {
      previewStore.restoreSnapshot(result.source.windowSnapshot.preview);
    }
  }
  chat.selectTab(openedTabId ?? result.source.tabId);
  closeDialog();
  void nextTick(() => emit("select", result.message.id));
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === "Escape" && open.value) {
    closeDialog();
  }
}

watch(open, (isOpen) => {
  document.body.style.overflow = isOpen ? "hidden" : "";
});

onMounted(() => {
  window.addEventListener("keydown", onKeydown);
});

onBeforeUnmount(() => {
  document.body.style.overflow = "";
  window.removeEventListener("keydown", onKeydown);
});
</script>

<template>
  <div class="session-search">
    <button
      ref="buttonRef"
      type="button"
      class="search-button"
      :title="uiText.title"
      :aria-label="uiText.title"
      @click="openDialog"
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="11" cy="11" r="7" />
        <path d="m16.5 16.5 3.5 3.5" />
      </svg>
    </button>
    <Teleport to="body">
      <div v-if="open" class="search-backdrop" @click="closeDialog">
        <section class="search-dialog" role="dialog" aria-modal="true" :aria-label="uiText.title" @click.stop>
          <header class="dialog-header">
            <h2>{{ uiText.title }}</h2>
            <button type="button" class="dialog-close" :aria-label="uiText.close" @click="closeDialog">×</button>
          </header>
          <div class="search-field">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="11" cy="11" r="7" />
              <path d="m16.5 16.5 3.5 3.5" />
            </svg>
            <input
              ref="searchInputRef"
              v-model="query"
              type="search"
              :placeholder="uiText.placeholder"
            />
          </div>
          <div v-if="loading" class="search-state">{{ uiText.loading }}</div>
          <div v-else-if="error" class="search-state error">{{ error }}</div>
          <div v-else-if="!normalizedQuery" class="search-state">{{ uiText.empty }}</div>
          <div v-else-if="results.length === 0" class="search-state">{{ uiText.noResults }}</div>
          <div v-else class="result-list">
            <button
              v-for="result in results"
              :key="result.key"
              type="button"
              class="result-item"
              @click="selectResult(result)"
            >
              <span class="result-title">{{ result.source.title }}</span>
              <span class="result-meta">
                {{ roleLabel(result.message.role) }} · {{ formatChatTime(result.message.timestamp || result.source.updatedAt) }}
              </span>
              <span class="result-excerpt">{{ result.excerpt }}</span>
            </button>
          </div>
        </section>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.session-search {
  position: relative;
  flex-shrink: 0;
}

.search-button {
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

.search-button:hover {
  background: color-mix(in srgb, var(--surface-hover) 72%, transparent);
  color: var(--text);
}

.search-button svg,
.search-field svg {
  width: 18px;
  height: 18px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.8;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.search-backdrop {
  position: fixed;
  inset: 0;
  z-index: 1100;
  display: grid;
  place-items: start center;
  padding-top: 12vh;
  background: rgb(0 0 0 / 44%);
}

.search-dialog {
  width: min(720px, calc(100vw - 32px));
  max-height: min(680px, calc(100vh - 24vh));
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--surface-elevated);
  box-shadow: 0 24px 60px rgb(0 0 0 / 46%);
  overflow: hidden;
}

.dialog-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 16px 8px;
}

.dialog-header h2 {
  margin: 0;
  color: var(--text);
  font-size: 15px;
}

.dialog-close {
  width: 28px;
  height: 28px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text-muted);
  font: inherit;
  font-size: 20px;
  cursor: pointer;
}

.dialog-close:hover {
  background: var(--surface-hover);
  color: var(--text);
}

.search-field {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 16px 12px;
  padding: 0 10px;
  height: 38px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
  color: var(--text-muted);
}

.search-field:focus-within {
  border-color: color-mix(in srgb, var(--accent) 58%, var(--border));
}

.search-field input {
  flex: 1;
  min-width: 0;
  border: none;
  outline: none;
  background: transparent;
  color: var(--text);
  font: inherit;
  font-size: 13px;
}

.search-state {
  padding: 24px 16px 30px;
  color: var(--text-muted);
  font-size: 13px;
  text-align: center;
}

.search-state.error {
  color: #ff8a8a;
}

.result-list {
  min-height: 0;
  overflow-y: auto;
  padding: 4px 8px 10px;
}

.result-item {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 4px 12px;
  width: 100%;
  border: none;
  border-radius: 8px;
  padding: 10px;
  background: transparent;
  color: var(--text);
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.result-item:hover {
  background: var(--surface-hover);
}

.result-title,
.result-excerpt {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.result-title {
  font-size: 13px;
  font-weight: 650;
}

.result-meta {
  color: var(--text-muted);
  font-size: 11px;
}

.result-excerpt {
  grid-column: 1 / -1;
  color: var(--text-muted);
  font-size: 12px;
  line-height: 1.5;
}
</style>
