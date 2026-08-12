<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { storeToRefs } from "pinia";
import { searchFiles } from "@/bridge";
import { useAppStateStore } from "@/stores/app-state";
import { useChatStore } from "@/stores/chat";
import { usePreviewStore } from "@/stores/preview";
import { useQuickOpenStore } from "@/stores/quick-open";
import { useSessionStore } from "@/stores/session";
import { useSettingsStore } from "@/stores/settings";
import { useWorkspaceStore } from "@/stores/workspace";
import { formatChatTime } from "@/utils/chat-time";
import { openWorkspaceFile } from "@/utils/open-workspace-file";
import { relativeWorkspacePath } from "@/utils/quick-open-path";
import {
  buildSessionSearchSourcesFromAppSessions,
  filterSessionHits,
  recentSessionHits,
  type SessionSearchHit,
  type SessionSearchSource,
} from "@/utils/session-search";

const emit = defineEmits<{
  "jump-message": [messageId: string];
}>();

interface FileItem {
  type: "file";
  key: string;
  name: string;
  path: string;
  relativePath: string;
}

interface SessionItem {
  type: "session";
  key: string;
  title: string;
  excerpt: string;
  meta: string;
  hit: SessionSearchHit;
}

type ListItem = FileItem | SessionItem;

const quickOpen = useQuickOpenStore();
const workspace = useWorkspaceStore();
const preview = usePreviewStore();
const chat = useChatStore();
const session = useSessionStore();
const appState = useAppStateStore();
const settings = useSettingsStore();
const { open } = storeToRefs(quickOpen);

const query = ref("");
const loadingFiles = ref(false);
const loadingSessions = ref(false);
const error = ref("");
const fileResults = ref<FileItem[]>([]);
const sessionSources = ref<SessionSearchSource[]>([]);
const activeIndex = ref(0);
const inputRef = ref<HTMLInputElement | null>(null);
let searchSeq = 0;
let searchTimer: number | undefined;

const isZh = computed(() => settings.locale === "zh");
const uiText = computed(() =>
  isZh.value
    ? {
        title: "全局搜索",
        placeholder: "搜索文件或会话…",
        files: "文件",
        sessions: "会话",
        recentFiles: "最近文件",
        recentSessions: "最近会话",
        emptyHint: "输入关键词搜索文件与会话",
        noResults: "没有匹配结果",
        loading: "搜索中…",
      }
    : {
        title: "Search",
        placeholder: "Search files or sessions…",
        files: "Files",
        sessions: "Sessions",
        recentFiles: "Recent files",
        recentSessions: "Recent sessions",
        emptyHint: "Type to search files and sessions",
        noResults: "No matching results",
        loading: "Searching…",
      },
);

const recentFileItems = computed((): FileItem[] => {
  const root = workspace.rootPath;
  return preview.tabs
    .filter((tab) => tab.kind === "code" && tab.filePath)
    .map((tab) => {
      const path = tab.filePath!;
      return {
        type: "file" as const,
        key: `recent-file:${path}`,
        name: tab.title || path.split("/").pop() || path,
        path,
        relativePath: root ? relativeWorkspacePath(root, path) : path,
      };
    });
});

const sessionItems = computed((): SessionItem[] => {
  const q = query.value.trim();
  const hits = q
    ? filterSessionHits(sessionSources.value, q, 30)
    : recentSessionHits(sessionSources.value, 20);
  return hits.map((hit) => ({
    type: "session" as const,
    key: hit.key,
    title: hit.source.title,
    excerpt: hit.excerpt,
    meta: hit.message
      ? formatChatTime(hit.message.timestamp || hit.source.updatedAt)
      : formatChatTime(hit.source.updatedAt),
    hit,
  }));
});

const fileItems = computed((): FileItem[] => {
  const q = query.value.trim();
  return q ? fileResults.value : recentFileItems.value;
});

const listItems = computed((): ListItem[] => [...fileItems.value, ...sessionItems.value]);

const loading = computed(() => loadingFiles.value || loadingSessions.value);

const filesSectionLabel = computed(() =>
  query.value.trim() ? uiText.value.files : uiText.value.recentFiles,
);

const sessionsSectionLabel = computed(() =>
  query.value.trim() ? uiText.value.sessions : uiText.value.recentSessions,
);

function closeDialog() {
  quickOpen.hide();
}

function resetState() {
  query.value = "";
  fileResults.value = [];
  error.value = "";
  loadingFiles.value = false;
  loadingSessions.value = false;
  activeIndex.value = 0;
  searchSeq += 1;
  if (searchTimer != null) {
    window.clearTimeout(searchTimer);
    searchTimer = undefined;
  }
}

async function refreshSessions() {
  loadingSessions.value = true;
  try {
    const appState = useAppStateStore();
    if (!appState.isLoaded) await appState.load();
    sessionSources.value = buildSessionSearchSourcesFromAppSessions(appState.sessions, {
      windowId: session.current.windowId,
      chat: chat.exportSnapshot(),
      preview: preview.exportSnapshot(),
    });
  } catch (loadError) {
    sessionSources.value = [];
    if (!error.value) {
      error.value = loadError instanceof Error ? loadError.message : String(loadError);
    }
  } finally {
    loadingSessions.value = false;
  }
}

async function runFileSearch(rawQuery: string) {
  const root = workspace.rootPath;
  const q = rawQuery.trim();
  if (!root || !q) {
    fileResults.value = [];
    loadingFiles.value = false;
    return;
  }

  const seq = ++searchSeq;
  loadingFiles.value = true;
  try {
    const entries = await searchFiles(root, q, 40);
    if (seq !== searchSeq) return;
    fileResults.value = entries
      .filter((entry) => !entry.isDir)
      .map((entry) => ({
        type: "file" as const,
        key: `search:${entry.path}`,
        name: entry.name,
        path: entry.path,
        relativePath: relativeWorkspacePath(root, entry.path),
      }));
  } catch (searchError) {
    if (seq !== searchSeq) return;
    fileResults.value = [];
    error.value =
      searchError instanceof Error ? searchError.message : String(searchError);
  } finally {
    if (seq === searchSeq) {
      loadingFiles.value = false;
      activeIndex.value = 0;
    }
  }
}

function scheduleFileSearch(rawQuery: string) {
  if (searchTimer != null) {
    window.clearTimeout(searchTimer);
  }
  searchTimer = window.setTimeout(() => {
    void runFileSearch(rawQuery);
  }, 120);
}

function openSessionSource(source: SessionSearchSource): string | null {
  let openedTabId: string | null = null;
  if (source.taskSnapshot) {
    openedTabId = chat.openSnapshotTab(source.taskSnapshot.chat, source.tabId);
    preview.restoreSnapshot(source.taskSnapshot.preview);
  } else if (source.windowSnapshot) {
    openedTabId = chat.openSnapshotTab(source.windowSnapshot.chat, source.tabId);
    if (source.windowId !== session.current.windowId) {
      preview.restoreSnapshot(source.windowSnapshot.preview);
    }
  }
  const tabId = openedTabId ?? source.tabId;
  const tab = chat.tabs.find((item) => item.id === tabId && item.kind === "chat");
  if (tab) {
    appState.upsertFromChatTab({
      id: tab.id,
      title: tab.title,
      kind: "chat",
      messages: tab.messages,
      lastError: tab.lastError ?? null,
      projectId: appState.previewProjectId,
    });
    void appState.openSession(tab.id);
  }
  chat.selectTab(tabId);
  return tabId;
}

async function openItem(item: ListItem) {
  closeDialog();
  if (item.type === "file") {
    await openWorkspaceFile(item.path);
    return;
  }
  openSessionSource(item.hit.source);
  const messageId =
    item.hit.message?.id ??
    [...item.hit.source.messages].reverse().find((message) => message.content.trim())?.id;
  if (messageId) {
    void nextTick(() => emit("jump-message", messageId));
  }
}

async function confirmActive() {
  const item = listItems.value[activeIndex.value];
  if (!item) return;
  await openItem(item);
}

function moveActive(delta: number) {
  const total = listItems.value.length;
  if (!total) return;
  activeIndex.value = (activeIndex.value + delta + total) % total;
}

function onDialogKeydown(event: KeyboardEvent) {
  if (event.key === "Escape") {
    event.preventDefault();
    closeDialog();
    return;
  }
  if (event.key === "ArrowDown") {
    event.preventDefault();
    moveActive(1);
    return;
  }
  if (event.key === "ArrowUp") {
    event.preventDefault();
    moveActive(-1);
    return;
  }
  if (event.key === "Enter") {
    event.preventDefault();
    void confirmActive();
  }
}

function flatIndexFor(section: "file" | "session", indexInSection: number): number {
  if (section === "file") return indexInSection;
  return fileItems.value.length + indexInSection;
}

watch(open, async (isOpen) => {
  document.body.style.overflow = isOpen ? "hidden" : "";
  if (!isOpen) {
    resetState();
    return;
  }
  resetState();
  await refreshSessions();
  await nextTick();
  inputRef.value?.focus();
});

watch(query, (value) => {
  activeIndex.value = 0;
  error.value = "";
  if (!value.trim()) {
    fileResults.value = [];
    loadingFiles.value = false;
    searchSeq += 1;
    return;
  }
  scheduleFileSearch(value);
});

watch(listItems, (items) => {
  if (activeIndex.value >= items.length) {
    activeIndex.value = Math.max(0, items.length - 1);
  }
});

onBeforeUnmount(() => {
  document.body.style.overflow = "";
  if (searchTimer != null) {
    window.clearTimeout(searchTimer);
  }
});
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="quick-open-backdrop"
      @click="closeDialog"
      @keydown="onDialogKeydown"
    >
      <section
        class="quick-open-dialog"
        role="dialog"
        aria-modal="true"
        :aria-label="uiText.title"
        @click.stop
      >
        <div class="quick-open-field">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="11" cy="11" r="7" />
            <path d="m16.5 16.5 3.5 3.5" />
          </svg>
          <input
            ref="inputRef"
            v-model="query"
            type="search"
            :placeholder="uiText.placeholder"
            autocomplete="off"
            spellcheck="false"
          />
        </div>

        <div v-if="loading && !listItems.length" class="quick-open-state">
          {{ uiText.loading }}
        </div>
        <div v-else-if="error && !listItems.length" class="quick-open-state error">
          {{ error }}
        </div>
        <div v-else-if="listItems.length === 0" class="quick-open-state">
          {{ query.trim() ? uiText.noResults : uiText.emptyHint }}
        </div>
        <div v-else class="quick-open-list">
          <template v-if="fileItems.length">
            <p class="list-hint">{{ filesSectionLabel }}</p>
            <button
              v-for="(item, index) in fileItems"
              :key="item.key"
              type="button"
              class="quick-open-item"
              :class="{ active: flatIndexFor('file', index) === activeIndex }"
              @mouseenter="activeIndex = flatIndexFor('file', index)"
              @click="openItem(item)"
            >
              <span class="item-name">{{ item.name }}</span>
              <span class="item-path">{{ item.relativePath }}</span>
            </button>
          </template>

          <template v-if="sessionItems.length">
            <p class="list-hint" :class="{ spaced: fileItems.length > 0 }">
              {{ sessionsSectionLabel }}
            </p>
            <button
              v-for="(item, index) in sessionItems"
              :key="item.key"
              type="button"
              class="quick-open-item session"
              :class="{ active: flatIndexFor('session', index) === activeIndex }"
              @mouseenter="activeIndex = flatIndexFor('session', index)"
              @click="openItem(item)"
            >
              <span class="item-row">
                <span class="item-name">{{ item.title }}</span>
                <span class="item-meta">{{ item.meta }}</span>
              </span>
              <span class="item-path">{{ item.excerpt }}</span>
            </button>
          </template>
        </div>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.quick-open-backdrop {
  position: fixed;
  inset: 0;
  z-index: 1200;
  display: grid;
  place-items: start center;
  padding-top: 12vh;
  background: rgb(0 0 0 / 44%);
}

.quick-open-dialog {
  width: min(640px, calc(100vw - 32px));
  max-height: min(560px, calc(100vh - 20vh));
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--surface-elevated-solid, var(--surface-elevated));
  box-shadow: 0 24px 60px rgb(0 0 0 / 46%);
  overflow: hidden;
}

.quick-open-field {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 14px 16px;
  border-bottom: 1px solid color-mix(in srgb, var(--border) 80%, transparent);
}

.quick-open-field svg {
  width: 18px;
  height: 18px;
  flex-shrink: 0;
  fill: none;
  stroke: var(--text-muted);
  stroke-width: 1.8;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.quick-open-field input {
  flex: 1;
  min-width: 0;
  border: none;
  outline: none;
  background: transparent;
  color: var(--text);
  font: inherit;
  font-size: 15px;
}

.quick-open-field input::placeholder {
  color: var(--text-muted);
}

.quick-open-state {
  padding: 20px 16px;
  color: var(--text-muted);
  font-size: 13px;
}

.quick-open-state.error {
  color: var(--danger-muted);
}

.quick-open-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-height: 0;
  overflow: auto;
  padding: 8px;
}

.list-hint {
  margin: 0 8px 6px;
  color: var(--text-muted);
  font-size: 11px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.list-hint.spaced {
  margin-top: 12px;
}

.quick-open-item {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  width: 100%;
  border: none;
  border-radius: 8px;
  padding: 8px 10px;
  background: transparent;
  color: var(--text);
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.quick-open-item.active,
.quick-open-item:hover {
  background: color-mix(in srgb, var(--accent) 14%, var(--surface-hover));
}

.item-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  width: 100%;
  min-width: 0;
}

.item-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  font-weight: 560;
}

.item-meta {
  flex-shrink: 0;
  color: var(--text-muted);
  font-size: 11px;
}

.item-path {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-muted);
  font-size: 11px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

.quick-open-item.session .item-path {
  font-family: inherit;
  font-size: 12px;
  white-space: nowrap;
}
</style>
