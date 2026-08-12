<script setup lang="ts">
import type { UnlistenFn } from "@tauri-apps/api/event";
import { storeToRefs } from "pinia";
import { computed, nextTick, onBeforeUnmount, onMounted, provide, ref, watch } from "vue";
import {
  listDir,
  executeShell,
  lspSymbolSearch,
  readFile,
  replaceContent,
  searchContent,
  searchFiles,
} from "@/bridge";
import { useHostStore } from "@/shell";
import { isBinaryFilePath, usePreviewStore } from "@/stores/preview";
import { openWorkspaceFile } from "@/utils/open-workspace-file";
import { useSettingsStore } from "@/stores/settings";
import { useWorkspaceStore } from "@/stores/workspace";
import type {
  DirEntry,
  FileContentSearchEntry,
  FileSearchEntry,
  GitChange,
  LspSymbolSearchEntry,
} from "@/types";
import ChevronIcon from "@/components/ui/ChevronIcon.vue";
import FileIcon from "../left/FileIcon.vue";
import FileTreeContextMenu from "../left/FileTreeContextMenu.vue";
import FileTreeNode from "../left/FileTreeNode.vue";
import {
  FILE_TREE_INLINE_CREATE_KEY,
  FILE_TREE_INLINE_RENAME_KEY,
  FILE_TREE_REFRESH_KEY,
  FILE_TREE_SCROLL_ROOT_KEY,
  normalizeFsPath,
  type FileTreeContextTarget,
  type FileTreeDirReloadRequest,
  type FileTreeInlineCreateMode,
  type FileTreeInlineCreateSession,
  type FileTreeInlineRenameSession,
  type FileTreeRefreshOptions,
} from "../left/file-tree-context";
import FileTreeInlineCreateRow from "../left/FileTreeInlineCreateRow.vue";
import type { TreeEntry } from "../left/file-tree-types";
import GitChanges from "../left/GitChanges.vue";
import type { GitSummary } from "../left/GitChanges.vue";
import { measureAsync, recordPerfEvent } from "@/perf";
import { alertDialog } from "@/utils/native-dialog";
import { syncCaller, syncLog } from "@/utils/sync-log";
import {
  createFileInDir,
  createFolderInDir,
  parentDir,
  renameEntry,
} from "@/utils/file-ops";

export type ExplorerView = "files" | "search" | "git";
type SearchResult = LspSymbolSearchEntry & {
  lineNumber?: number;
  lineText?: string;
};

const props = withDefaults(
  defineProps<{
    view?: ExplorerView;
    /** Hide local activity bar when parent owns the shared toolbar. */
    hideActivityBar?: boolean;
  }>(),
  { hideActivityBar: false },
);
const emit = defineEmits<{
  "update:view": [ExplorerView];
}>();

const entries = ref<TreeEntry[]>([]);
const gitChanges = ref<GitChange[]>([]);
const gitSummary = ref<GitSummary>({
  branch: "",
  upstream: "",
  ahead: 0,
  behind: 0,
  rebasing: false,
});
const searchQuery = ref("");
const replaceQuery = ref("");
const includeQuery = ref("");
const excludeQuery = ref("");
const isReplaceOpen = ref(false);
const searchResults = ref<SearchResult[]>([]);
const isRootOpen = ref(true);
const localView = ref<ExplorerView>("files");
const activeView = computed({
  get: () => props.view ?? localView.value,
  set: (value: ExplorerView) => {
    if (props.view !== undefined) emit("update:view", value);
    else localView.value = value;
  },
});
const isLoading = ref(false);
const isSearching = ref(false);
const loadError = ref("");
const searchError = ref("");
const leftPanelRef = ref<HTMLElement | null>(null);
const fileTreeScrollRef = ref<HTMLElement | null>(null);
const searchInputRef = ref<HTMLInputElement | null>(null);
const contextMenuRef = ref<InstanceType<typeof FileTreeContextMenu> | null>(null);
const revealPath = ref<string | null>(null);
let searchTimer: number | undefined;
let revealScrollTimer: number | undefined;
let unlistenOpenFolder: UnlistenFn | undefined;
let unlistenHostPatch: UnlistenFn | undefined;
const host = useHostStore();
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
      newFile: "New File…",
      newFolder: "New Folder…",
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
    newFile: "新建文件…",
    newFolder: "新建文件夹…",
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

function entriesSignature(items: TreeEntry[]): string {
  return items.map((item) => `${item.name}\0${item.isDir ? "1" : "0"}`).join("\n");
}

async function refreshGitStatus(_path = workspace.rootPath) {
  gitSummary.value = { ...gitSummary.value, loading: true, error: "" };
  const started = performance.now();
  try {
    if (!host.booted) await host.boot();
    await host.refreshGit(host.previewProject?.id);
    syncGitFromHost();
    gitSummary.value = { ...gitSummary.value, loading: false, actionRunning: false };
    const durationMs = Math.round(performance.now() - started);
    if (durationMs >= 40) {
      recordPerfEvent({
        kind: "slow_op",
        severity: durationMs >= 200 ? "error" : "warn",
        durationMs,
        name: "boot.gitStatus",
        detail: `host.git ${durationMs}ms`,
        meta: { via: "host", changes: gitChanges.value.length },
      });
    }
  } catch {
    gitChanges.value = [];
    gitSummary.value = {
      ...gitSummary.value,
      loading: false,
      actionRunning: false,
      error: "Git 状态读取失败",
    };
  }
}

async function runGitAction(args: string[]) {
  if (!workspace.rootPath) return;
  gitSummary.value = { ...gitSummary.value, actionRunning: true, error: "" };
  try {
    const result = await executeShell("git", args, workspace.rootPath, undefined, true);
    if (result.exitCode !== 0) {
      gitSummary.value = {
        ...gitSummary.value,
        actionRunning: false,
        error: result.stderr || result.stdout || `git ${args.join(" ")} 执行失败`,
      };
      await refreshGitStatus(workspace.rootPath);
      return;
    }
    await refreshGitStatus(workspace.rootPath);
  } catch (error) {
    gitSummary.value = {
      ...gitSummary.value,
      actionRunning: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function openGitDiff(change: GitChange) {
  if (!workspace.rootPath) return;
  const path = change.path;
  try {
    const unstaged = await executeShell("git", ["diff", "--", path], workspace.rootPath);
    let content = unstaged.stdout;
    if (!content.trim()) {
      const staged = await executeShell("git", ["diff", "--cached", "--", path], workspace.rootPath);
      content = staged.stdout;
    }
    if (!content.trim() && change.status.includes("?")) {
      const fileContent = await readFile(`${workspace.rootPath}/${path}`);
      content = [
        `diff --git a/${path} b/${path}`,
        "new file mode 100644",
        "index 0000000..0000000",
        "--- /dev/null",
        `+++ b/${path}`,
        ...fileContent.split("\n").map((line) => `+${line}`),
      ].join("\n");
    }
    preview.openDiffFile(path, content.trim() ? content : `# No diff available for ${path}\n`);
  } catch (error) {
    preview.openDiffFile(path, `# Failed to load git diff\n\n${error instanceof Error ? error.message : String(error)}\n`);
  }
}

async function fetchGit() {
  await runGitAction(["fetch", "--prune"]);
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

function switchView(view: ExplorerView) {
  activeView.value = view;
  if (view === "search") {
    void nextTick(() => searchInputRef.value?.focus());
  }
}

async function scrollRevealedFileIntoView() {
  const root = fileTreeScrollRef.value ?? leftPanelRef.value;
  if (!root) return;
  for (let attempt = 0; attempt < 24; attempt += 1) {
    await nextTick();
    const active = root.querySelector<HTMLElement>(".row.active");
    if (active) {
      active.scrollIntoView({ block: "center", behavior: "smooth" });
      return;
    }
    await new Promise<void>((resolve) => {
      window.setTimeout(resolve, 40);
    });
  }
}

function revealActiveFile(path: string | null) {
  if (!path || !workspace.rootPath) return;
  activeView.value = "files";
  isRootOpen.value = true;
  revealPath.value = path;
  if (revealScrollTimer != null) {
    window.clearTimeout(revealScrollTimer);
  }
  // Let nested directory loads expand before scrolling.
  revealScrollTimer = window.setTimeout(() => {
    void scrollRevealedFileIntoView();
  }, 80);
}

function showFileTreeContextMenu(event: MouseEvent, target: FileTreeContextTarget) {
  contextMenuRef.value?.showMenu(event, target);
}

function onRootContextMenu(event: MouseEvent) {
  if (!workspace.rootPath) return;
  showFileTreeContextMenu(event, {
    path: workspace.rootPath,
    name: workspaceName.value,
    isDir: true,
  });
}

function rootCreateTarget(): FileTreeContextTarget | null {
  if (!workspace.rootPath) return null;
  return {
    path: workspace.rootPath,
    name: workspaceName.value,
    isDir: true,
  };
}

function onRootNewFile() {
  const target = rootCreateTarget();
  if (!target) return;
  isRootOpen.value = true;
  beginInlineCreate(target, "new-file");
}

function onRootNewFolder() {
  const target = rootCreateTarget();
  if (!target) return;
  isRootOpen.value = true;
  beginInlineCreate(target, "new-folder");
}

const treeEpoch = ref(0);
const dirReloadRequest = ref<FileTreeDirReloadRequest | null>(null);

async function refreshFileTree(options?: FileTreeRefreshOptions) {
  if (!workspace.rootPath) return;
  const root = normalizeFsPath(workspace.rootPath);
  const reloadDir = options?.reloadDir
    ? normalizeFsPath(options.reloadDir)
    : null;

  if (reloadDir && reloadDir !== root) {
    // Targeted refresh: only re-list the affected subdirectory.
    dirReloadRequest.value = { path: reloadDir, token: Date.now() };
  } else {
    await loadWorkspace(workspace.rootPath, { quiet: true });
  }

  if (options?.revealPath) {
    revealActiveFile(options.revealPath);
  }
}

const inlineRenameSession = ref<FileTreeInlineRenameSession | null>(null);
const inlineCreateSession = ref<FileTreeInlineCreateSession | null>(null);

const isCreatingAtRoot = computed(() => {
  if (!inlineCreateSession.value || !workspace.rootPath) return false;
  return (
    normalizeFsPath(inlineCreateSession.value.parentPath) ===
    normalizeFsPath(workspace.rootPath)
  );
});

function beginInlineRename(target: FileTreeContextTarget) {
  inlineCreateSession.value = null;
  inlineRenameSession.value = { path: target.path, name: target.name };
}

function cancelInlineRename() {
  inlineRenameSession.value = null;
}

async function commitInlineRename(nextName: string) {
  const current = inlineRenameSession.value;
  if (!current) return;
  inlineRenameSession.value = null;
  const trimmed = nextName.trim();
  if (!trimmed || trimmed === current.name) return;
  try {
    const nextPath = await renameEntry(current.path, trimmed);
    await refreshFileTree({
      reloadDir: parentDir(current.path),
      ...(nextPath ? { revealPath: nextPath } : {}),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await alertDialog(message, { kind: "error" });
  }
}

function beginInlineCreate(
  parent: FileTreeContextTarget,
  mode: FileTreeInlineCreateMode,
) {
  if (!parent.isDir) return;
  inlineRenameSession.value = null;
  inlineCreateSession.value = { parentPath: parent.path, mode };
  if (
    workspace.rootPath &&
    normalizeFsPath(parent.path) === normalizeFsPath(workspace.rootPath)
  ) {
    isRootOpen.value = true;
  }
}

function cancelInlineCreate() {
  inlineCreateSession.value = null;
}

async function commitInlineCreate(name: string) {
  const current = inlineCreateSession.value;
  if (!current) return;
  const trimmed = name.trim();
  if (!trimmed) {
    inlineCreateSession.value = null;
    return;
  }
  inlineCreateSession.value = null;
  try {
    const created =
      current.mode === "new-file"
        ? await createFileInDir(current.parentPath, trimmed)
        : await createFolderInDir(current.parentPath, trimmed);
    await refreshFileTree({
      reloadDir: current.parentPath,
      revealPath: created,
    });
  } catch (error) {
    // Keep the inline row open so the user can fix the name.
    inlineCreateSession.value = current;
    const message = error instanceof Error ? error.message : String(error);
    await alertDialog(message, { kind: "error" });
  }
}

provide(FILE_TREE_REFRESH_KEY, refreshFileTree);
provide(FILE_TREE_INLINE_RENAME_KEY, {
  session: inlineRenameSession,
  begin: beginInlineRename,
  commit: commitInlineRename,
  cancel: cancelInlineRename,
});
provide(FILE_TREE_INLINE_CREATE_KEY, {
  session: inlineCreateSession,
  begin: beginInlineCreate,
  commit: commitInlineCreate,
  cancel: cancelInlineCreate,
});
provide(FILE_TREE_SCROLL_ROOT_KEY, fileTreeScrollRef);
provide("fileTreeShowContextMenu", showFileTreeContextMenu);

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
  await openWorkspaceFile(result.path);
}

function relativePath(path: string): string {
  if (!workspace.rootPath) return path;
  const prefix = `${workspace.rootPath.replace(/\/$/, "")}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

async function loadWorkspace(
  path: string,
  options: { quiet?: boolean; soft?: boolean } = {},
): Promise<boolean> {
  if (!path) return false;
  if (!options.quiet) {
    isLoading.value = true;
  }
  loadError.value = "";
  syncLog("explorer.loadWorkspace", {
    path,
    soft: Boolean(options.soft),
    currentRoot: workspace.rootPath,
    by: syncCaller(),
  });
  const started = performance.now();
  try {
    if (!host.booted) {
      await host.boot();
    }
    // Host owns open + watch + git; shell only projects the result.
    if (!options.soft) {
      await host.openWorkspace(path);
    }
    const items = await measureAsync(
      "boot.listDirRoot",
      () => host.listDir(path),
      {
        warnMs: 16,
        errorMs: 100,
        recordOnlySlow: false,
        meta: { path, soft: Boolean(options.soft) },
      },
    );
    const nextEntries = toTreeEntries(
      path,
      items.map((item) => ({ name: item.name, isDir: item.isDir })),
    );
    if (!options.soft) {
      workspace.setRoot(path);
    }
    if (
      !options.soft ||
      entriesSignature(entries.value) !== entriesSignature(nextEntries)
    ) {
      entries.value = nextEntries;
    }
    if (!options.soft) {
      treeEpoch.value += 1;
      // `host.workspace.open` above already upserted the project and made it the
      // preview project — mirroring that in the Shell would be a second writer.
      syncGitFromHost();
    }
    console.info(
      `[BootPerf] loadWorkspace ${Math.round(performance.now() - started)}ms path=${path} entries=${items.length} soft=${Boolean(options.soft)}`,
    );
    return true;
  } catch (error) {
    if (!options.soft) {
      entries.value = [];
      gitChanges.value = [];
    }
    loadError.value = error instanceof Error ? error.message : String(error);
    return false;
  } finally {
    if (!options.quiet) {
      isLoading.value = false;
    }
  }
}

function syncGitFromHost() {
  const project = host.previewProject;
  if (!project) return;
  const runtime = host.doc.projectRuntime[project.id];
  if (!runtime) return;
  gitChanges.value = runtime.gitChanges.map((change) => ({
    path: change.path,
    status: change.status,
  }));
  gitSummary.value = {
    branch: runtime.gitSummary.branch,
    upstream: runtime.gitSummary.upstream,
    ahead: runtime.gitSummary.ahead,
    behind: runtime.gitSummary.behind,
    rebasing: runtime.gitSummary.rebasing,
    loading: runtime.gitSummary.loading,
    error: runtime.gitSummary.error,
  };
}

function applyHostWorkspaceProjection() {
  const project = host.previewProject;
  if (!project) {
    syncLog("explorer.projection.skip", {
      reason: "no preview project",
      currentRoot: workspace.rootPath,
    });
    return;
  }
  const runtime = host.doc.projectRuntime[project.id];
  // No runtime yet (project restored from disk but never opened this run): the
  // preview-project watcher loads it, which is what primes the runtime.
  if (!runtime) {
    syncLog("explorer.projection.skip", {
      reason: "no runtime",
      projectId: project.id,
      root: project.rootPath,
    });
    return;
  }
  const root = project.rootPath;
  if (workspace.rootPath !== root) {
    workspace.setRoot(root);
  }
  const nextEntries = toTreeEntries(
    root,
    runtime.entries.map((item) => ({ name: item.name, isDir: item.isDir })),
  );
  if (entriesSignature(entries.value) !== entriesSignature(nextEntries)) {
    entries.value = nextEntries;
  }
  syncGitFromHost();
}

// Follow the Host's preview project. Activating a session in another project
// changes it, and the tree has to load that root even when the Host has no
// runtime for it yet.
watch(
  () => host.previewProject?.rootPath ?? "",
  (root, previousRoot) => {
    if (!root) return;
    if (normalizeFsPath(root) === normalizeFsPath(workspace.rootPath)) return;
    syncLog("explorer.previewProjectChanged", {
      from: previousRoot ?? "",
      to: root,
      currentRoot: workspace.rootPath,
    });
    activeView.value = activeView.value === "search" ? "files" : activeView.value;
    void loadWorkspace(root);
  },
);

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
  const bootStarted = performance.now();
  try {
    const { listen: listenHost } = await import("@tauri-apps/api/event");
    unlistenOpenFolder = await listenHost<{
      kind?: string;
      action?: string;
      path?: string;
    }>("host:event", async (event) => {
      if (event.payload.kind !== "menu" || event.payload.action !== "open_folder") {
        return;
      }
      const path = event.payload.path;
      if (!path) {
        applyHostWorkspaceProjection();
        return;
      }
      activeView.value = "files";
      searchQuery.value = "";
      searchResults.value = [];
      await loadWorkspace(path);
    });
    unlistenHostPatch = await listenHost("host:patch", () => {
      applyHostWorkspaceProjection();
    });
    const homeDir = await import("@tauri-apps/api/path").then((m) => m.homeDir());
    const hostPreview = host.previewProject?.rootPath;
    const restoredRoot = hostPreview || workspace.restoreRoot();
    const restored = restoredRoot ? await loadWorkspace(restoredRoot) : false;
    if (!restored) {
      const root = await resolveDefaultWorkspace(homeDir);
      await loadWorkspace(root);
    }
    // No JS polling — Host notify + git worker push host:patch.
    console.info(
      `[BootPerf] ProjectExplorer ready ${Math.round(performance.now() - bootStarted)}ms root=${workspace.rootPath}`,
    );
  } catch {
    entries.value = [];
    gitChanges.value = [];
  }
});

onBeforeUnmount(() => {
  unlistenOpenFolder?.();
  unlistenHostPatch?.();
  stopSearchTimer();
  if (revealScrollTimer != null) {
    window.clearTimeout(revealScrollTimer);
  }
});

watch([searchQuery, includeQuery, excludeQuery], () => {
  scheduleSearch();
});

watch(
  () => [activeFilePath.value, preview.revealToken] as const,
  ([path]) => {
    revealActiveFile(path);
  },
  { immediate: true },
);
</script>

<template>
  <aside
    ref="leftPanelRef"
    class="project-explorer"
    :class="{ embedded: hideActivityBar }"
    data-shortcut-scope="preview"
  >
    <nav v-if="!hideActivityBar" class="activity-bar" :aria-label="uiText.sidebar">
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
            <span class="root-chevron" aria-hidden="true">
              <ChevronIcon :expanded="isRootOpen" />
            </span>
            <span class="root-name">{{ workspaceName }}</span>
          </span>
        </button>
        <span class="root-actions">
          <span v-if="isLoading" class="loading">{{ uiText.loading }}</span>
          <button
            type="button"
            class="root-action-button"
            :title="uiText.newFile"
            :aria-label="uiText.newFile"
            :disabled="!workspace.rootPath || isLoading"
            @click.stop="onRootNewFile"
          >
            <!-- document + plus -->
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M3.25 1.75h5.1L12.75 6.1v8.15H3.25V1.75Z" />
              <path d="M8.35 1.75v4.35h4.4" />
              <path d="M6.1 10.1h3.8M8 8.2v3.8" />
            </svg>
          </button>
          <button
            type="button"
            class="root-action-button"
            :title="uiText.newFolder"
            :aria-label="uiText.newFolder"
            :disabled="!workspace.rootPath || isLoading"
            @click.stop="onRootNewFolder"
          >
            <!-- folder + plus -->
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M1.75 3.5h4.2l1.35 1.45h7.45v7.3a.75.75 0 0 1-.75.75H2.5a.75.75 0 0 1-.75-.75V3.5Z" />
              <path d="M6.2 9.85h3.6M8 8.05v3.6" />
            </svg>
          </button>
          <button
            type="button"
            class="root-action-button"
            :title="uiText.syncNow"
            :aria-label="uiText.syncNow"
            :disabled="!workspace.rootPath || isLoading"
            @click.stop="refreshFileTree()"
          >
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M13.25 8a5.25 5.25 0 1 1-1.35-3.5" />
              <path d="M13.25 2.75v3.1h-3.1" />
            </svg>
          </button>
        </span>
      </div>
      <div
        v-if="isRootOpen"
        ref="fileTreeScrollRef"
        class="file-tree-scroll"
        data-file-tree-scroll
        @contextmenu="onRootContextMenu"
      >
        <ul v-if="entries.length || isCreatingAtRoot">
          <FileTreeInlineCreateRow
            v-if="isCreatingAtRoot && inlineCreateSession"
            :mode="inlineCreateSession.mode"
            :depth="0"
            @commit="commitInlineCreate"
            @cancel="cancelInlineCreate"
          />
          <FileTreeNode
            v-for="entry in entries"
            :key="entry.path"
            :entry="entry"
            :selected-path="activeFilePath"
            :reveal-path="revealPath"
            :tree-epoch="treeEpoch"
            :dir-reload="dirReloadRequest"
          />
        </ul>
        <p v-else-if="loadError" class="load-error" role="alert">{{ loadError }}</p>
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
            :aria-expanded="isReplaceOpen"
            title="Replace"
            @click="isReplaceOpen = !isReplaceOpen"
          >
            <ChevronIcon :expanded="isReplaceOpen" />
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
            :class="{ disabled: isBinaryFilePath(result.path) }"
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
      <GitChanges
        :changes="gitChanges"
        :summary="gitSummary"
        @refresh="refreshGitStatus()"
        @fetch="fetchGit"
        @pull-rebase="runGitAction(['pull', '--rebase'])"
        @rebase-continue="runGitAction(['rebase', '--continue'])"
        @rebase-abort="runGitAction(['rebase', '--abort'])"
        @open-diff="openGitDiff"
      />
    </section>

    <FileTreeContextMenu ref="contextMenuRef" />
  </aside>
</template>

<style scoped>
.project-explorer {
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: 100%;
  padding: 0;
  border-right: 1px solid var(--border);
  background: transparent;
  overflow: hidden;
  user-select: none;
}

.project-explorer.embedded {
  border-right: none;
}

.activity-bar {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  flex-shrink: 0;
  height: 36px;
  padding: 0 6px;
  border-bottom: 1px solid var(--border);
}

.activity-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border: none;
  border-radius: 5px;
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
  width: 15px;
  height: 15px;
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
  font-size: 14px;
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

.root-action-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border: none;
  border-radius: 5px;
  padding: 0;
  background: transparent;
  color: var(--text-muted);
  font: inherit;
  opacity: 0;
  transition:
    opacity 120ms ease,
    color 120ms ease,
    background 120ms ease;
  cursor: pointer;
}

.root-action-button svg {
  width: 15px;
  height: 15px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.25;
  stroke-linecap: round;
  stroke-linejoin: round;
  vector-effect: non-scaling-stroke;
}

.root-row:hover .root-action-button,
.root-action-button:focus-visible {
  opacity: 1;
}

.root-action-button:hover {
  color: var(--text);
  background: var(--surface-hover);
}

.root-action-button:disabled {
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
  color: var(--danger-muted);
}

.load-error {
  margin: 6px 8px;
  padding: 6px 8px;
  border: 1px solid color-mix(in srgb, var(--danger-muted) 45%, transparent);
  border-radius: 6px;
  background: color-mix(in srgb, var(--danger-muted) 12%, transparent);
  color: var(--danger-muted);
  font-size: 11px;
  line-height: 1.35;
  word-break: break-word;
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
  font-size: 14px;
  cursor: pointer;
}

.replace-chevron:hover {
  background: var(--surface-hover);
  color: var(--text);
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
  background: var(--surface-inset);
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
  background: var(--surface-inset);
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
