<script setup lang="ts">
import { storeToRefs } from "pinia";
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
} from "vue";
import { readFile, readFileDataUrl } from "@/bridge";
import ProjectExplorer, {
  type ExplorerView,
} from "@/components/explorer/ProjectExplorer.vue";
import CodeEditor from "./CodeEditor.vue";
import DiffMergeEditor from "./DiffMergeEditor.vue";
import PreviewTab from "./PreviewTab.vue";
import { useAppStateStore } from "@/stores/app-state";
import { usePreviewStore } from "@/stores/preview";
import { useSettingsStore } from "@/stores/settings";
import { useWorkspaceStore } from "@/stores/workspace";
import PanelToggleButton from "@/components/ui/PanelToggleButton.vue";
import { isDiffPreview } from "@/preview/diff";
import { confirmDialog } from "@/utils/native-dialog";
import { scrollTabIntoView } from "@/utils/scroll-tab-into-view";

const explorerOpen = defineModel<boolean>("explorerOpen", { default: true });
const editorOpen = defineModel<boolean>("editorOpen", { default: true });

const emit = defineEmits<{
  collapse: [];
}>();

const preview = usePreviewStore();
const workspace = useWorkspaceStore();
const settings = useSettingsStore();
const appState = useAppStateStore();
const { tabs, activeTabId } = storeToRefs(preview);
const { rootPath } = storeToRefs(workspace);
const { previewProject } = storeToRefs(appState);
const explorerView = ref<ExplorerView>("files");
const tabsRef = ref<HTMLElement | null>(null);
const canScrollLeft = ref(false);
const canScrollRight = ref(false);
let resizeObserver: ResizeObserver | null = null;
let fileRefreshTimer: number | undefined;
let isRefreshingFiles = false;

const activeTab = computed(() =>
  tabs.value.find((tab) => tab.id === activeTabId.value)
);
const showEditor = computed(() => editorOpen.value && tabs.value.length > 0);

const uiText = computed(() =>
  settings.locale === "en"
    ? {
        files: "Files",
        search: "Search",
        sidebar: "Explorer",
        collapseExplorer: "Collapse file explorer",
        expandExplorer: "Expand file explorer",
        collapsePreview: "Collapse files & preview",
      }
    : {
        files: "文件",
        search: "搜索",
        sidebar: "资源管理器",
        collapseExplorer: "收起文件树",
        expandExplorer: "展开文件树",
        collapsePreview: "收起文件与预览",
      }
);

function selectExplorerView(view: ExplorerView) {
  explorerView.value = view;
  if (!explorerOpen.value) {
    explorerOpen.value = true;
  }
}

function toggleExplorer() {
  explorerOpen.value = !explorerOpen.value;
}

function selectTab(id: string) {
  preview.activeTabId = id;
  editorOpen.value = true;
}

const tabDropIndex = ref<number | null>(null);

function reorderTab(tabId: string, insertionIndex: number) {
  tabDropIndex.value = null;
  // The exportSnapshot watcher below persists the new order via app-state.
  preview.moveTab(tabId, insertionIndex);
}

function updateTabScrollHints() {
  const element = tabsRef.value;
  if (!element) {
    canScrollLeft.value = false;
    canScrollRight.value = false;
    return;
  }

  const maxScrollLeft = element.scrollWidth - element.clientWidth;
  canScrollLeft.value = element.scrollLeft > 1;
  canScrollRight.value = element.scrollLeft < maxScrollLeft - 1;
}

function scrollTabs(direction: "left" | "right") {
  const element = tabsRef.value;
  if (!element) return;

  element.scrollBy({
    left: direction === "left" ? -240 : 240,
    behavior: "smooth",
  });
}

/** Keep the active preview tab inside the horizontal viewport (<< / >> overflow). */
function scrollActiveTabIntoView() {
  // Leave room for the << / >> affordances that sit over the tab strip.
  scrollTabIntoView(tabsRef.value, activeTabId.value, {
    edgePad: 36,
    behavior: "smooth",
  });
  updateTabScrollHints();
}

async function closeTab(id: string) {
  const tab = tabs.value.find((item) => item.id === id);
  if (tab?.isDirty) {
    const shouldClose = await confirmDialog(
      `${tab.title} 有未保存的修改，确认关闭并丢弃这些修改吗？`
    );
    if (!shouldClose) return;
  }
  preview.closeTab(id);
}

async function refreshOpenCodeTabsFromDisk() {
  if (isRefreshingFiles) return;
  const cleanCodeTabs = tabs.value.filter(
    (tab) =>
      tab.kind === "code" && tab.filePath && !tab.isDirty && !tab.readOnly
  );
  if (cleanCodeTabs.length === 0) return;

  isRefreshingFiles = true;
  try {
    await Promise.all(
      cleanCodeTabs.map(async (tab) => {
        if (!tab.filePath) return;
        try {
          const content = await readFile(tab.filePath);
          preview.refreshCleanCodeFile(tab.filePath, content);
        } catch {
          // Files can disappear or be temporarily unavailable while tools run.
        }
      })
    );
  } finally {
    isRefreshingFiles = false;
  }
}

onMounted(() => {
  resizeObserver = new ResizeObserver(updateTabScrollHints);
  if (tabsRef.value) {
    resizeObserver.observe(tabsRef.value);
  }
  void nextTick(updateTabScrollHints);
  fileRefreshTimer = window.setInterval(() => {
    void refreshOpenCodeTabsFromDisk();
  }, 1_000);
});

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  resizeObserver = null;
  if (fileRefreshTimer) {
    window.clearInterval(fileRefreshTimer);
  }
  fileRefreshTimer = undefined;
});

watch(
  () => [tabs.value.length, activeTabId.value] as const,
  () => {
    // Wait for the active tab node (and any newly appended tab) to lay out.
    void nextTick(() => {
      requestAnimationFrame(scrollActiveTabIntoView);
    });
  }
);

watch(
  () => tabs.value.length,
  (count, previous) => {
    if (count > 0 && (previous === 0 || previous === undefined)) {
      editorOpen.value = true;
    }
  }
);

/** Image data URLs are intentionally omitted from persisted preview state. */
watch(
  () => activeTab.value,
  (tab) => {
    if (tab?.kind !== "image" || !tab.filePath || tab.content) return;
    void readFileDataUrl(tab.filePath)
      .then((media) => {
        // The user may have switched or closed the tab while the file was read.
        preview.setImageFileContent(tab.filePath!, media.dataUrl, media.bytes);
      })
      .catch((error: unknown) => {
        console.warn("[PreviewPanel] failed to restore image preview:", error);
      });
  },
  { immediate: true }
);

watch(
  () => preview.exportSnapshot(),
  (snapshot) => {
    if (previewProject.value) {
      appState.saveProjectPreview(previewProject.value.id, snapshot);
    }
  },
  { deep: true }
);
</script>

<template>
  <section
    class="preview-panel"
    :class="{
      'explorer-open': explorerOpen,
      'editor-open': showEditor,
    }"
    data-shortcut-scope="preview"
  >
    <template v-if="previewProject">
      <header class="preview-toolbar">
        <div
          class="toolbar-explorer"
          :class="{ collapsed: !explorerOpen, 'has-tabs': tabs.length > 0 }"
        >
          <PanelToggleButton
            side="left"
            :open="explorerOpen"
            :title="
              explorerOpen ? uiText.collapseExplorer : uiText.expandExplorer
            "
            @click="toggleExplorer"
          />
          <nav class="activity-bar" :aria-label="uiText.sidebar">
            <button
              type="button"
              class="activity-button"
              :class="{ active: explorerOpen && explorerView === 'files' }"
              :title="uiText.files"
              :aria-label="uiText.files"
              @click="selectExplorerView('files')"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M6 2.75h8.2L19.25 7.8v13.45H6z" />
                <path d="M14 3v5h5" />
              </svg>
            </button>
            <button
              type="button"
              class="activity-button"
              :class="{ active: explorerOpen && explorerView === 'search' }"
              :title="uiText.search"
              :aria-label="uiText.search"
              @click="selectExplorerView('search')"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <circle cx="10.5" cy="10.5" r="6.25" />
                <path d="m15.25 15.25 5 5" />
              </svg>
            </button>
            <button
              type="button"
              class="activity-button"
              :class="{ active: explorerOpen && explorerView === 'git' }"
              title="Git"
              aria-label="Git"
              @click="selectExplorerView('git')"
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
        </div>

        <div class="tabs-shell">
          <button
            v-if="canScrollLeft"
            type="button"
            class="tab-scroll-hint left"
            aria-label="向左滚动标签"
            @click="scrollTabs('left')"
          >
            &lt;&lt;
          </button>
          <nav
            v-if="tabs.length"
            ref="tabsRef"
            class="tabs"
            data-tab-group="preview"
            @scroll="updateTabScrollHints"
          >
            <PreviewTab
              v-for="(tab, index) in tabs"
              :key="tab.id"
              :tab-id="tab.id"
              :title="tab.title"
              :file-path="tab.filePath"
              :dirty="tab.isDirty"
              :active="tab.id === activeTabId"
              :drop-before="tabDropIndex === index"
              :drop-after="
                tabDropIndex === tabs.length && index === tabs.length - 1
              "
              @select="selectTab(tab.id)"
              @close="closeTab(tab.id)"
              @reorder="reorderTab(tab.id, $event)"
              @preview-drop="tabDropIndex = $event"
            />
          </nav>
          <button
            v-if="canScrollRight"
            type="button"
            class="tab-scroll-hint right"
            aria-label="向右滚动标签"
            @click="scrollTabs('right')"
          >
            &gt;&gt;
          </button>
        </div>

        <div class="toolbar-actions" :class="{ 'has-tabs': tabs.length > 0 }">
          <PanelToggleButton
            side="right"
            :open="true"
            :title="uiText.collapsePreview"
            @click="emit('collapse')"
          />
        </div>
      </header>

      <div class="preview-body">
        <ProjectExplorer
          v-if="explorerOpen"
          v-model:view="explorerView"
          hide-activity-bar
          class="explorer-pane"
        />
        <div v-if="showEditor" class="editor-pane">
          <div class="content">
            <DiffMergeEditor
              v-if="
                activeTab?.kind === 'code' &&
                activeTab.filePath &&
                activeTab.content != null &&
                isDiffPreview(activeTab.source, activeTab.filePath)
              "
              :file-path="activeTab.filePath"
              :content="activeTab.content"
            />
            <CodeEditor
              v-else-if="
                activeTab?.kind === 'code' &&
                activeTab.filePath &&
                activeTab.content != null
              "
              :file-path="activeTab.filePath"
              :content="activeTab.content"
              :saved-content="activeTab.savedContent"
              :workspace-root="rootPath"
              :language-id="activeTab.languageId"
              :enable-lsp="preview.lspEnabled"
              :read-only="activeTab.readOnly"
              @change="
                preview.updateCodeFileContent(activeTab.filePath, $event)
              "
              @saved="preview.markCodeFileSaved(activeTab.filePath, $event)"
            />
            <div
              v-else-if="activeTab?.kind === 'image' && activeTab.content"
              class="image-preview"
            >
              <img :src="activeTab.content" :alt="activeTab.title" />
            </div>
            <p v-else class="placeholder">{{ activeTab?.kind }} 预览尚未实现</p>
          </div>
        </div>
        <p v-else-if="!explorerOpen" class="placeholder empty-body">
          {{ uiText.expandExplorer }}
        </p>
      </div>
    </template>
    <p v-else class="placeholder empty-project">打开文件夹以浏览文件</p>
  </section>
</template>

<style scoped>
.preview-panel {
  --explorer-col-basis: min(240px, 34%);
  --explorer-col-min: 180px;
  --explorer-col-max: 300px;
  display: flex;
  flex-direction: column;
  height: 100%;
  min-width: 0;
  background: color-mix(in srgb, var(--bg) 92%, transparent);
  overflow: hidden;
}

.preview-toolbar {
  display: flex;
  align-items: stretch;
  flex-shrink: 0;
  height: 36px;
  min-width: 0;
  border-bottom: 1px solid color-mix(in srgb, var(--border) 80%, transparent);
  background: color-mix(in srgb, var(--surface) 55%, transparent);
}

.toolbar-explorer {
  display: flex;
  align-items: center;
  gap: 4px;
  /* Keep in sync with .explorer-pane so the tab strip starts on the same edge. */
  flex: 0 0 var(--explorer-col-basis);
  min-width: var(--explorer-col-min);
  max-width: var(--explorer-col-max);
  box-sizing: border-box;
  padding: 0 6px;
}

.toolbar-explorer.collapsed {
  flex: 0 0 auto;
  min-width: 0;
  max-width: none;
}

.toolbar-explorer.has-tabs {
  border-right: 1px solid color-mix(in srgb, var(--border) 70%, transparent);
}

.activity-bar {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
}

.toolbar-actions {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  flex-shrink: 0;
  padding: 0 6px;
}

.toolbar-actions.has-tabs {
  border-left: 1px solid color-mix(in srgb, var(--border) 70%, transparent);
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

.tabs-shell {
  position: relative;
  display: flex;
  flex: 1;
  align-items: stretch;
  min-width: 0;
}

.tabs {
  display: flex;
  align-items: stretch;
  flex: 1;
  height: 36px;
  padding: 0;
  overflow-x: auto;
  overflow-y: hidden;
  overscroll-behavior-x: contain;
  scrollbar-width: none;
}

.tabs::-webkit-scrollbar {
  display: none;
}

.tab-scroll-hint {
  position: absolute;
  top: 50%;
  z-index: 2;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 24px;
  border: none;
  border-radius: 5px;
  background: color-mix(in srgb, var(--surface-elevated) 88%, transparent);
  color: var(--text-muted);
  font-size: 10px;
  letter-spacing: -1px;
  transform: translateY(-50%);
  cursor: pointer;
}

.tab-scroll-hint:hover {
  color: var(--text);
  background: var(--surface-hover);
}

.tab-scroll-hint.left {
  left: 4px;
  box-shadow: 12px 0 18px color-mix(in srgb, var(--surface) 92%, transparent);
}

.tab-scroll-hint.right {
  right: 4px;
  box-shadow: -12px 0 18px color-mix(in srgb, var(--surface) 92%, transparent);
}

.preview-body {
  display: flex;
  flex: 1;
  min-height: 0;
  min-width: 0;
}

.explorer-pane {
  flex: 1;
  min-width: 0;
  background: transparent;
}

.preview-panel.editor-open .explorer-pane {
  flex: 0 0 var(--explorer-col-basis);
  min-width: var(--explorer-col-min);
  max-width: var(--explorer-col-max);
  box-sizing: border-box;
  border-right: 1px solid color-mix(in srgb, var(--border) 70%, transparent);
}

.editor-pane {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
  background: transparent;
}

.empty-body {
  flex: 1;
}

.content {
  flex: 1;
  min-height: 0;
  padding: 0;
  overflow: hidden;
}

.image-preview {
  display: grid;
  place-items: center;
  height: 100%;
  padding: 16px;
  overflow: auto;
  /* Images need an opaque canvas: a patterned/translucent background becomes
     visible through transparent pixels and reads as image corruption. */
  background: var(--surface-inset-solid, var(--surface-inset));
  -webkit-backdrop-filter: none;
  backdrop-filter: none;
}

.image-preview img {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  border-radius: 6px;
  box-shadow: 0 8px 28px color-mix(in srgb, #000 35%, transparent);
}

.placeholder {
  display: grid;
  height: 100%;
  margin: 0;
  place-items: center;
  font-size: 13px;
  color: var(--text-muted);
}

.empty-project {
  display: grid;
  place-items: center;
  flex: 1;
  margin: 0;
  color: var(--muted);
  font-size: 13px;
}
</style>
