<script setup lang="ts">
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { storeToRefs } from "pinia";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import {
  gitStatus,
  listDir,
  lspSymbolSearch,
  readFile,
  replaceContent,
  searchContent,
  searchFiles,
} from "@/bridge";
import { isCodeFilePath, usePreviewStore } from "@/stores/preview";
import { useSettingsStore } from "@/stores/settings";
import { useWorkspaceStore } from "@/stores/workspace";
import type {
  DirEntry,
  FileContentSearchEntry,
  FileSearchEntry,
  GitChange,
  LspSymbolSearchEntry,
} from "@/types";
import FileIcon from "./FileIcon.vue";
import FileTreeNode from "./FileTreeNode.vue";
import type { TreeEntry } from "./file-tree-types";
import GitChanges from "./GitChanges.vue";

type LeftView = "files" | "search" | "git";
type SearchResult = LspSymbolSearchEntry & {
  lineNumber?: number;
  lineText?: string;
};

const entries = ref<TreeEntry[]>([]);
const gitChanges = ref<GitChange[]>([]);
const searchQuery = ref("");
const replaceQuery = ref("");
const includeQuery = ref("");
const excludeQuery = ref("");
const isReplaceOpen = ref(false);
const searchResults = ref<SearchResult[]>([]);
const isRootOpen = ref(true);
const activeView = ref<LeftView>("files");
const isLoading = ref(false);
const isSearching = ref(false);
const loadError = ref("");
const searchError = ref("");
const leftPanelRef = ref<HTMLElement | null>(null);
const searchInputRef = ref<HTMLInputElement | null>(null);
let fileTreeTimer: number | undefined;
let gitTimer: number | undefined;
let searchTimer: number | undefined;
let unlistenOpenFolder: UnlistenFn | undefined;
const workspace = useWorkspaceStore();
const preview = usePreviewStore();
const settings = useSettingsStore();
const { tabs, activeTabId } = storeToRefs(preview);

const workspaceName = computed(() => {
  if (!workspace.rootPath) return "工作区";
  return workspace.rootPath.split("/").filter(Boolean).pop() ?? workspace.rootPath;
});

const activeFilePath = computed(() => {
  const activeTab = tabs.value.find((tab) => tab.id === activeTabId.value);
  return activeTab?.filePath ?? null;
});

const hasSearchQuery = computed(() => searchQuery.value.trim().length > 0);

const searchStatus = computed(() => {
  if (isSearching.value) return settings.locale === "en" ? "Searching..." : "搜索中…";
  if (searchError.value) return searchError.value;
  if (hasSearchQuery.value) {
    return settings.locale === "en"
      ? `${searchResults.value.length} results`
      : `${searchResults.value.length} 个结果`;
  }
  return "";
});

const uiText = computed(() => {
  if (settings.locale === "en") {
    return {
      sidebar: "Sidebar",
      files: "Files",
      search: "Search",
      loading: "Loading...",
      syncNow: "Sync now",
      emptyDir: "Directory is empty",
      searchPlaceholder: "Search",
      replacePlaceholder: "Replace",
      includePlaceholder: "files to include",
      excludePlaceholder: "files to exclude",
      clearSearch: "Clear search",
      replaceAll: "Replace all",
      noResults: "No matching results",
      gitChanges: "Git Changes",
      directory: "Directory",
      file: "File",
    };
  }
  return {
    sidebar: "侧栏",
    files: "文件",
    search: "搜索",
    loading: "加载中…",
    syncNow: "立即同步",
    emptyDir: "目录为空",
    searchPlaceholder: "搜索",
    replacePlaceholder: "替换",
    includePlaceholder: "包含文件",
    excludePlaceholder: "排除文件",
    clearSearch: "清空搜索",
    replaceAll: "全部替换",
    noResults: "没有匹配的结果",
    gitChanges: "Git 变更",
    directory: "目录",
    file: "文件",
  };
});

function joinPath(parent: string, name: string): string {
  return `${parent.replace(/\/$/, "")}/${name}`;
}

function toTreeEntries(parent: string, items: DirEntry[]): TreeEntry[] {
  return items.map((item) => ({
    ...item,
    path: joinPath(parent, item.name),
  }));
}

async function refreshGitStatus(path = workspace.rootPath) {
  if (!path) return;
  try {
    gitChanges.value = await gitStatus(path);
  } catch {
    gitChanges.value = [];
  }
}

async function runSearch() {
  const query = searchQuery.value.trim();
  if (!workspace.rootPath || !query) {
    searchResults.value = [];
    searchError.value = "";
    return;
  }

  isSearching.value = true;
  searchError.value = "";
  try {
    const [symbolResults, fileResults, contentResults] = await Promise.allSettled([
      lspSymbolSearch(workspace.rootPath, query),
      searchFiles(workspace.rootPath, query, 40, includeQuery.value, excludeQuery.value),
      searchContent(workspace.rootPath, query, 80, includeQuery.value, excludeQuery.value),
    ]);
    const nextResults = mergeSearchResults(
      symbolResults.status === "fulfilled"
        ? filterSymbolResults(symbolResults.value)
        : [],
      fileResults.status === "fulfilled" ? fileResults.value : [],
      contentResults.status === "fulfilled" ? contentResults.value : [],
    );
    searchResults.value = nextResults;
    const failures = [symbolResults, fileResults, contentResults].filter(
      (result) => result.status === "rejected",
    );
    searchError.value =
      nextResults.length === 0 && failures.length === 3
        ? String((failures[0] as PromiseRejectedResult).reason)
        : "";
  } catch (searchFailure) {
    searchResults.value = [];
    searchError.value =
      searchFailure instanceof Error ? searchFailure.message : String(searchFailure);
  } finally {
    isSearching.value = false;
  }
}

function filterSymbolResults(results: LspSymbolSearchEntry[]): LspSymbolSearchEntry[] {
  const include = parseClientPatterns(includeQuery.value);
  const exclude = parseClientPatterns(excludeQuery.value);
  return results.filter((result) => {
    const path = relativePath(result.path).toLowerCase();
    if (exclude.some((pattern) => clientPathMatches(path, pattern))) return false;
    return include.length === 0 || include.some((pattern) => clientPathMatches(path, pattern));
  });
}

function parseClientPatterns(value: string): string[] {
  return value
    .split(/[,\s]+/)
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function clientPathMatches(path: string, pattern: string): boolean {
  if (!pattern.includes("*")) return path.includes(pattern);
  const expression = new RegExp(
    `^${pattern.split("*").map(escapeRegExp).join(".*")}$`,
    "i",
  );
  return expression.test(path);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function toFileSearchEntry(entry: FileSearchEntry): SearchResult {
  return {
    name: entry.name,
    kind: entry.isDir ? uiText.value.directory : uiText.value.file,
    path: entry.path,
  };
}

function toContentSearchEntry(entry: FileContentSearchEntry): SearchResult {
  return {
    name: entry.name,
    kind:
      settings.locale === "en"
        ? `Line ${entry.lineNumber}`
        : `第 ${entry.lineNumber} 行`,
    path: entry.path,
    lineNumber: entry.lineNumber,
    lineText: entry.line,
  };
}

function mergeSearchResults(
  symbols: LspSymbolSearchEntry[],
  files: FileSearchEntry[],
  content: FileContentSearchEntry[],
): SearchResult[] {
  const seen = new Set<string>();
  const results: SearchResult[] = [];
  const add = (key: string, result: SearchResult) => {
    if (seen.has(key)) return;
    seen.add(key);
    results.push(result);
  };

  for (const item of symbols) {
    add(`symbol:${item.path}:${item.kind}:${item.name}`, item);
  }
  for (const item of files) {
    add(`file:${item.path}`, toFileSearchEntry(item));
  }
  for (const item of content) {
    add(`content:${item.path}:${item.lineNumber}`, toContentSearchEntry(item));
  }
  return results.slice(0, 120);
}

function scheduleSearch() {
  if (searchTimer) {
    window.clearTimeout(searchTimer);
  }
  searchTimer = window.setTimeout(() => {
    void runSearch();
  }, 180);
}

function switchView(view: LeftView) {
  activeView.value = view;
  if (view === "search") {
    void nextTick(() => searchInputRef.value?.focus());
  }
}

function clearSearch() {
  searchQuery.value = "";
  searchResults.value = [];
  searchError.value = "";
  searchInputRef.value?.focus();
}

async function replaceAll() {
  const query = searchQuery.value;
  if (!workspace.rootPath || !query) return;

  isSearching.value = true;
  searchError.value = "";
  try {
    await replaceContent(
      workspace.rootPath,
      query,
      replaceQuery.value,
      includeQuery.value,
      excludeQuery.value,
    );
    await runSearch();
  } catch (error) {
    searchError.value = error instanceof Error ? error.message : String(error);
  } finally {
    isSearching.value = false;
  }
}

async function openSearchResult(result: SearchResult) {
  if (!isCodeFilePath(result.path)) return;
  try {
    const content = await readFile(result.path);
    preview.openCodeFile(result.path, content);
  } catch (error) {
    console.warn("[FileSearch] failed to open file:", error);
  }
}

function relativePath(path: string): string {
  if (!workspace.rootPath) return path;
  const prefix = `${workspace.rootPath.replace(/\/$/, "")}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

async function loadWorkspace(path: string, options: { quiet?: boolean } = {}): Promise<boolean> {
  if (!path) return false;
  if (!options.quiet) {
    isLoading.value = true;
  }
  loadError.value = "";
  try {
    const items = await listDir(path);
    workspace.setRoot(path);
    entries.value = toTreeEntries(path, items);
    await refreshGitStatus(path);
    return true;
  } catch (error) {
    entries.value = [];
    gitChanges.value = [];
    loadError.value = error instanceof Error ? error.message : String(error);
    return false;
  } finally {
    if (!options.quiet) {
      isLoading.value = false;
    }
  }
}

function startAutoRefresh() {
  fileTreeTimer = window.setInterval(() => {
    void loadWorkspace(workspace.rootPath, { quiet: true });
  }, 10_000);
  gitTimer = window.setInterval(() => {
    void refreshGitStatus();
  }, 3_000);
}

function stopAutoRefresh() {
  if (fileTreeTimer) {
    window.clearInterval(fileTreeTimer);
  }
  if (gitTimer) {
    window.clearInterval(gitTimer);
  }
  fileTreeTimer = undefined;
  gitTimer = undefined;
}

function stopSearchTimer() {
  if (searchTimer) {
    window.clearTimeout(searchTimer);
  }
  searchTimer = undefined;
}

async function resolveDefaultWorkspace(home: string): Promise<string> {
  const candidates = [
    `${home}/workspace/open-vera`,
    `${home}/workspace`,
    home,
  ];
  for (const candidate of candidates) {
    try {
      await listDir(candidate);
      return candidate;
    } catch {
      // try next candidate
    }
  }
  return home;
}

onMounted(async () => {
  try {
    unlistenOpenFolder = await listen<{ path: string }>(
      "workspace:open-folder",
      async (event) => {
        activeView.value = "files";
        searchQuery.value = "";
        searchResults.value = [];
        await loadWorkspace(event.payload.path);
      },
    );
    const homeDir = await import("@tauri-apps/api/path").then((m) => m.homeDir());
    const restoredRoot = workspace.restoreRoot();
    const restored = restoredRoot ? await loadWorkspace(restoredRoot) : false;
    if (!restored) {
      const root = await resolveDefaultWorkspace(homeDir);
      await loadWorkspace(root);
    }
    startAutoRefresh();
  } catch {
    entries.value = [];
    gitChanges.value = [];
  }
});

onBeforeUnmount(() => {
  unlistenOpenFolder?.();
  stopAutoRefresh();
  stopSearchTimer();
});

watch([searchQuery, includeQuery, excludeQuery], () => {
  scheduleSearch();
});
</script>

<template>
  <aside ref="leftPanelRef" class="left-panel" data-shortcut-scope="left">
    <nav class="activity-bar" :aria-label="uiText.sidebar">
      <button
        type="button"
        class="activity-button"
        :class="{ active: activeView === 'files' }"
        :title="uiText.files"
        :aria-label="uiText.files"
        @click="switchView('files')"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M6 2.75h8.2L19.25 7.8v13.45H6z" />
          <path d="M14 3v5h5" />
        </svg>
      </button>
      <button
        type="button"
        class="activity-button"
        :class="{ active: activeView === 'search' }"
        :title="uiText.search"
        :aria-label="uiText.search"
        @click="switchView('search')"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="10.5" cy="10.5" r="6.25" />
          <path d="m15.25 15.25 5 5" />
        </svg>
      </button>
      <button
        type="button"
        class="activity-button"
        :class="{ active: activeView === 'git' }"
        title="Git"
        aria-label="Git"
        @click="switchView('git')"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="6" cy="5" r="2.2" />
          <circle cx="18" cy="5" r="2.2" />
          <circle cx="12" cy="19" r="2.2" />
          <path d="M6 7.2v3.3c0 2.1 1.7 3.8 3.8 3.8H12" />
          <path d="M18 7.2v3.3c0 2.1-1.7 3.8-3.8 3.8H12v2.5" />
        </svg>
      </button>
    </nav>

    <section v-if="activeView === 'files'" class="panel-view file-tree">
      <div class="section-header root-row">
        <button
          type="button"
          class="root-toggle"
          :aria-expanded="isRootOpen"
          @click="isRootOpen = !isRootOpen"
        >
          <span class="root-label">
            <span class="root-chevron" :class="{ expanded: isRootOpen }" aria-hidden="true">
              <svg viewBox="0 0 20 20">
                <path d="M5 8l5 5 5-5" />
              </svg>
            </span>
            <span class="root-name">{{ workspaceName }}</span>
          </span>
        </button>
        <span class="root-actions">
          <span v-if="isLoading" class="loading">{{ uiText.loading }}</span>
          <button
            type="button"
            class="refresh-button"
            :title="uiText.syncNow"
            :disabled="!workspace.rootPath || isLoading"
            @click.stop="loadWorkspace(workspace.rootPath)"
          >
            ↻
          </button>
        </span>
      </div>
      <div v-if="isRootOpen" class="file-tree-scroll">
        <ul v-if="entries.length">
          <FileTreeNode
            v-for="entry in entries"
            :key="entry.path"
            :entry="entry"
            :selected-path="activeFilePath"
          />
        </ul>
        <p v-else-if="loadError" class="empty error">{{ loadError }}</p>
        <p v-else class="empty">{{ uiText.emptyDir }}</p>
      </div>
    </section>

    <section v-else-if="activeView === 'search'" class="panel-view search-view">
      <div class="search-controls">
        <div class="search-header">
          <span>{{ uiText.search }}</span>
        </div>
        <div class="search-row">
          <button
            type="button"
            class="replace-chevron"
            :class="{ expanded: isReplaceOpen }"
            :aria-expanded="isReplaceOpen"
            title="Replace"
            @click="isReplaceOpen = !isReplaceOpen"
          >
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <path d="M5 8l5 5 5-5" />
            </svg>
          </button>
          <div class="search-box">
            <input
              ref="searchInputRef"
              v-model="searchQuery"
              class="search-input"
              type="search"
              :placeholder="uiText.searchPlaceholder"
            />
            <button
              v-if="hasSearchQuery"
              type="button"
              class="clear-search"
              :aria-label="uiText.clearSearch"
              @click="clearSearch"
            >
              ×
            </button>
          </div>
        </div>
        <div v-if="isReplaceOpen" class="replace-row">
          <span class="replace-spacer" aria-hidden="true" />
          <div class="search-box replace-box">
            <input
              v-model="replaceQuery"
              class="search-input"
              type="text"
              :placeholder="uiText.replacePlaceholder"
            />
            <button
              type="button"
              class="replace-all"
              :disabled="!searchQuery"
              @click="replaceAll"
            >
              {{ uiText.replaceAll }}
            </button>
          </div>
        </div>
        <div class="filter-group">
          <input
            v-model="includeQuery"
            class="filter-input"
            type="text"
            :placeholder="uiText.includePlaceholder"
          />
          <input
            v-model="excludeQuery"
            class="filter-input"
            type="text"
            :placeholder="uiText.excludePlaceholder"
          />
        </div>
        <div class="search-meta" :class="{ error: Boolean(searchError) }">{{ searchStatus }}</div>
      </div>
      <ul v-if="searchResults.length" class="search-results">
        <li
          v-for="result in searchResults"
          :key="`${result.path}:${result.lineNumber ?? result.name}:${result.kind}`"
        >
          <button
            type="button"
            class="search-result"
            :class="{ disabled: !isCodeFilePath(result.path) }"
            :title="relativePath(result.path)"
            @click="openSearchResult(result)"
          >
            <FileIcon class="result-icon" :path="result.path" />
            <span class="result-text">
              <span class="result-name">{{ result.name }}</span>
              <span class="result-path">{{ result.kind }} · {{ relativePath(result.path) }}</span>
              <span v-if="result.lineText" class="result-line">{{ result.lineText }}</span>
            </span>
          </button>
        </li>
      </ul>
      <p v-else-if="hasSearchQuery && !isSearching && !searchError" class="empty">
        {{ uiText.noResults }}
      </p>
    </section>

    <section v-else class="panel-view git-section">
      <div class="view-title">
        <span>Git 变更</span>
        <span class="count">{{ gitChanges.length }}</span>
      </div>
      <GitChanges :changes="gitChanges" />
    </section>
  </aside>
</template>

<style scoped>
.left-panel {
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: 100%;
  padding: 0;
  border-right: 1px solid var(--border);
  background: var(--surface);
  overflow: hidden;
  user-select: none;
}

.activity-bar {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  flex-shrink: 0;
  height: 40px;
  padding: 0 8px;
}

.activity-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
}

.activity-button:hover,
.activity-button.active {
  background: var(--surface-hover);
  color: var(--text);
}

.activity-button svg {
  width: 17px;
  height: 17px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.7;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.panel-view {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.file-tree {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-shrink: 0;
  min-height: 24px;
  padding: 4px 8px 4px 12px;
  color: var(--text);
}

.section-header:hover {
  background: var(--surface-hover);
}

.root-row {
  min-width: 0;
}

.root-toggle {
  flex: 1;
  min-width: 0;
  border: none;
  padding: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.root-label {
  display: flex;
  align-items: center;
  min-width: 0;
}

.root-chevron {
  width: 18px;
  height: 18px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  color: var(--text-muted);
}

.root-chevron svg {
  width: 14px;
  height: 14px;
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
  transform: rotate(-90deg);
  transition: transform 120ms ease;
}

.root-chevron.expanded svg {
  transform: rotate(0deg);
}

.root-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.03em;
}

.root-actions {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 20px;
  min-width: 20px;
}

.refresh-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border: none;
  border-radius: 4px;
  padding: 0;
  background: transparent;
  color: var(--text-muted);
  font: inherit;
  font-size: 13px;
  opacity: 0;
  transition: opacity 120ms ease;
  cursor: pointer;
}

.root-row:hover .refresh-button,
.refresh-button:focus-visible {
  opacity: 1;
}

.refresh-button:hover {
  color: var(--text);
  background: var(--surface-hover);
}

.refresh-button:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.loading {
  font-size: 11px;
  color: var(--text-muted);
}

.file-tree-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 4px 0 8px 10px;
}

ul {
  list-style: none;
  margin: 0;
  padding: 0;
}

.empty {
  margin: 8px;
  font-size: 12px;
  color: var(--text-muted);
}

.error {
  color: #f28b82;
}

.view-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-shrink: 0;
  min-height: 28px;
  padding: 5px 8px;
  border-bottom: 1px solid color-mix(in srgb, var(--border) 72%, transparent);
  color: var(--text-muted);
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.03em;
}

.search-view {
  padding: 0;
}

.search-controls {
  flex-shrink: 0;
  padding-bottom: 6px;
}

.search-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-shrink: 0;
  min-height: 30px;
  padding: 4px 10px 2px;
  color: var(--text-muted);
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.03em;
}

.search-row {
  display: flex;
  align-items: center;
  gap: 2px;
  flex-shrink: 0;
  margin: 4px 10px 0;
}

.replace-row {
  display: flex;
  align-items: center;
  gap: 2px;
  flex-shrink: 0;
  margin: 4px 10px 0;
}

.replace-spacer {
  width: 20px;
  height: 32px;
  flex-shrink: 0;
}

.replace-chevron {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 32px;
  flex-shrink: 0;
  border: none;
  border-radius: 4px;
  padding: 0;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
}

.replace-chevron:hover {
  background: var(--surface-hover);
  color: var(--text);
}

.replace-chevron svg {
  width: 14px;
  height: 14px;
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
  transform: rotate(-90deg);
  transition: transform 120ms ease;
}

.replace-chevron.expanded svg {
  transform: rotate(0deg);
}

.search-box {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  height: 32px;
  margin: 0;
  padding: 0 8px;
  border: 1px solid var(--border);
  border-radius: 3px;
  background: var(--bg);
}

.search-box:focus-within {
  border-color: color-mix(in srgb, var(--accent) 70%, var(--border));
  outline: 1px solid color-mix(in srgb, var(--accent) 40%, transparent);
}

.search-input {
  min-width: 0;
  flex: 1;
  border: none;
  padding: 0;
  background: transparent;
  color: var(--text);
  font: inherit;
  font-size: 12px;
}

.search-input:focus {
  outline: none;
}

.search-input::-webkit-search-cancel-button {
  display: none;
}

.replace-box {
  padding-right: 4px;
}

.replace-all {
  flex-shrink: 0;
  height: 24px;
  border: none;
  border-radius: 4px;
  padding: 0 7px;
  background: var(--surface-hover);
  color: var(--text-muted);
  font: inherit;
  font-size: 11px;
  cursor: pointer;
}

.replace-all:hover:not(:disabled) {
  color: var(--text);
}

.replace-all:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.filter-input {
  flex-shrink: 0;
  height: 30px;
  width: 100%;
  border: 1px solid var(--border);
  border-radius: 3px;
  padding: 0 8px;
  background: var(--bg);
  color: var(--text);
  font: inherit;
  font-size: 12px;
}

.filter-group {
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex-shrink: 0;
  margin: 6px 10px 0 32px;
}

.filter-input:focus {
  border-color: color-mix(in srgb, var(--accent) 70%, var(--border));
  outline: 1px solid color-mix(in srgb, var(--accent) 40%, transparent);
}

.clear-search {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  flex-shrink: 0;
  border: none;
  border-radius: 4px;
  padding: 0;
  background: transparent;
  color: var(--text-muted);
  font-size: 15px;
  line-height: 1;
  cursor: pointer;
}

.clear-search:hover {
  background: var(--surface-hover);
  color: var(--text);
}

.search-meta {
  flex-shrink: 0;
  min-height: 20px;
  padding: 5px 12px 0 32px;
  color: var(--text-muted);
  font-size: 11px;
}

.search-results {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 0 0 8px;
}

.search-result {
  display: flex;
  align-items: flex-start;
  gap: 7px;
  width: 100%;
  min-height: 34px;
  border: none;
  padding: 5px 10px;
  background: transparent;
  color: inherit;
  text-align: left;
  cursor: pointer;
}

.search-result:hover {
  background: var(--surface-hover);
}

.search-result.disabled {
  cursor: default;
}

.result-icon {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 16px;
  height: 16px;
}

.result-text {
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.result-name,
.result-path,
.result-line {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.result-name {
  font-size: 12px;
}

.result-path {
  color: var(--text-muted);
  font-size: 11px;
}

.result-line {
  margin-top: 1px;
  color: color-mix(in srgb, var(--text-muted) 82%, var(--text));
  font-size: 11px;
}

.git-section {
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.count {
  font-size: 11px;
}

.git-section :deep(.git-changes) {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  margin-top: 0;
  padding: 4px 8px 8px;
}
</style>
