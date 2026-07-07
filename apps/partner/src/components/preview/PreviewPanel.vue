<script setup lang="ts">
import { storeToRefs } from "pinia";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { readFile } from "@/bridge";
import CodeEditor from "./CodeEditor.vue";
import PreviewTab from "./PreviewTab.vue";
import { usePreviewStore } from "@/stores/preview";
import { useWorkspaceStore } from "@/stores/workspace";

const preview = usePreviewStore();
const workspace = useWorkspaceStore();
const { tabs, activeTabId } = storeToRefs(preview);
const { rootPath } = storeToRefs(workspace);
const tabsRef = ref<HTMLElement | null>(null);
const canScrollLeft = ref(false);
const canScrollRight = ref(false);
let resizeObserver: ResizeObserver | null = null;
let fileRefreshTimer: number | undefined;
let isRefreshingFiles = false;

const activeTab = computed(() =>
  tabs.value.find((tab) => tab.id === activeTabId.value),
);

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

function closeTab(id: string) {
  const tab = tabs.value.find((item) => item.id === id);
  if (tab?.isDirty) {
    const shouldClose = window.confirm(
      `${tab.title} 有未保存的修改，确认关闭并丢弃这些修改吗？`,
    );
    if (!shouldClose) return;
  }
  preview.closeTab(id);
}

async function refreshOpenCodeTabsFromDisk() {
  if (isRefreshingFiles) return;
  const cleanCodeTabs = tabs.value.filter(
    (tab) => tab.kind === "code" && tab.filePath && !tab.isDirty,
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
      }),
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
    void nextTick(updateTabScrollHints);
  },
);
</script>

<template>
  <section class="preview-panel" data-shortcut-scope="preview">
    <div v-if="tabs.length" class="tabs-shell">
      <button
        v-if="canScrollLeft"
        type="button"
        class="tab-scroll-hint left"
        aria-label="向左滚动标签"
        @click="scrollTabs('left')"
      >
        &lt;&lt;
      </button>
      <nav ref="tabsRef" class="tabs" @scroll="updateTabScrollHints">
        <PreviewTab
          v-for="tab in tabs"
          :key="tab.id"
          :title="tab.title"
          :dirty="tab.isDirty"
          :active="tab.id === activeTabId"
          @select="preview.activeTabId = tab.id"
          @close="closeTab(tab.id)"
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

    <div class="content">
      <CodeEditor
        v-if="activeTab?.kind === 'code' && activeTab.filePath && activeTab.content != null"
        :file-path="activeTab.filePath"
        :content="activeTab.content"
        :saved-content="activeTab.savedContent"
        :workspace-root="rootPath"
        :language-id="activeTab.languageId"
        :enable-lsp="preview.lspEnabled"
        @change="preview.updateCodeFileContent(activeTab.filePath, $event)"
        @saved="preview.markCodeFileSaved(activeTab.filePath, $event)"
      />
      <p v-else-if="activeTab" class="placeholder">
        {{ activeTab.kind }} 预览尚未实现
      </p>
      <p v-else class="placeholder">点击左侧文件在此预览代码</p>
    </div>
  </section>
</template>

<style scoped>
.preview-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-width: 0;
  background: var(--bg);
}

.tabs-shell {
  position: relative;
  flex-shrink: 0;
  height: 40px;
  min-width: 0;
  background: var(--surface);
}

.tabs {
  display: flex;
  height: 40px;
  padding: 0;
  background: var(--surface);
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

.content {
  flex: 1;
  min-height: 0;
  padding: 0;
  overflow: hidden;
}

.placeholder {
  display: grid;
  height: 100%;
  margin: 0;
  place-items: center;
  font-size: 13px;
  color: var(--text-muted);
}
</style>
