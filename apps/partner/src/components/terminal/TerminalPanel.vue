<script setup lang="ts">
import { storeToRefs } from "pinia";
import { computed, nextTick, ref, watch } from "vue";
import { useAppStateStore } from "@/stores/app-state";
import { useSettingsStore } from "@/stores/settings";
import { useTerminalStore } from "@/stores/terminal";
import { useWorkspaceStore } from "@/stores/workspace";
import { resolveSessionCwd } from "@/utils/session-cwd";
import TerminalSession from "./TerminalSession.vue";

const terminal = useTerminalStore();
const workspace = useWorkspaceStore();
const appState = useAppStateStore();
const settings = useSettingsStore();
const { tabs, activeTabId, open } = storeToRefs(terminal);

const labels = computed(() =>
  settings.locale === "en"
    ? {
        newTab: "New Terminal",
        closeTab: "Close Terminal",
        closePanel: "Close Panel",
        terminal: "Terminal",
      }
    : {
        newTab: "新建终端",
        closeTab: "关闭终端",
        closePanel: "关闭面板",
        terminal: "终端",
      },
);

const sessionRefs = ref<Record<string, InstanceType<typeof TerminalSession> | null>>({});

function truncateTitle(title: string): string {
  if (title.length <= 18) return title;
  return `${title.slice(0, 14)}…`;
}

function createTab() {
  const resolved = resolveSessionCwd({
    activeTabId: appState.activeTabId,
    sessions: appState.sessions,
    projects: appState.projects,
    workspaceRootPath: workspace.rootPath,
  });
  const tab = terminal.addTab({
    title: resolved.label || labels.value.terminal,
    cwd: resolved.cwd,
  });
  void nextTick(() => {
    sessionRefs.value[tab.id]?.focus?.();
  });
}

function ensureTab() {
  if (tabs.value.length === 0) {
    createTab();
  }
}

function onCloseTab(id: string) {
  terminal.closeTab(id);
}

function onClosePanel() {
  terminal.closePanel();
}

function onSelectTab(id: string) {
  terminal.setActiveTab(id);
  void nextTick(() => {
    sessionRefs.value[id]?.focus?.();
  });
}

function onReady(payload: { tabId: string; title: string }) {
  terminal.updateTitle(payload.tabId, payload.title);
}

watch(open, (isOpen) => {
  if (!isOpen) return;
  ensureTab();
  void nextTick(() => {
    const id = activeTabId.value;
    if (id) {
      sessionRefs.value[id]?.fit?.();
      sessionRefs.value[id]?.focus?.();
    }
  });
});

defineExpose({ createTab, ensureTab });
</script>

<template>
  <section
    class="terminal-panel"
    data-shortcut-scope="bottom"
  >
    <header class="terminal-tabs">
      <div class="tab-list">
        <button
          v-for="tab in tabs"
          :key="tab.id"
          type="button"
          class="tab"
          :class="{ active: tab.id === activeTabId, exited: tab.exited }"
          @click="onSelectTab(tab.id)"
        >
          <span class="tab-icon" aria-hidden="true">
            <svg viewBox="0 0 16 16">
              <rect x="1.5" y="3" width="13" height="10" rx="1.2" />
              <path d="M4 6.5h3.5M4 9h5" />
            </svg>
          </span>
          <span class="tab-title">{{ truncateTitle(tab.title) }}</span>
          <span
            class="tab-close"
            role="button"
            :title="labels.closeTab"
            :aria-label="labels.closeTab"
            @click.stop="onCloseTab(tab.id)"
          >
            ×
          </span>
        </button>
        <button
          type="button"
          class="tab-action"
          :title="labels.newTab"
          :aria-label="labels.newTab"
          @click="createTab"
        >
          +
        </button>
      </div>
      <button
        type="button"
        class="tab-action panel-close"
        :title="labels.closePanel"
        :aria-label="labels.closePanel"
        @click="onClosePanel"
      >
        ×
      </button>
    </header>
    <div class="terminal-body">
      <TerminalSession
        v-for="tab in tabs"
        :key="tab.id"
        :ref="(el) => { sessionRefs[tab.id] = el as InstanceType<typeof TerminalSession> | null }"
        :tab-id="tab.id"
        :cwd="tab.cwd"
        :active="tab.id === activeTabId"
        @ready="onReady"
      />
      <p v-if="!tabs.length" class="empty">{{ labels.terminal }}</p>
    </div>
  </section>
</template>

<style scoped>
.terminal-panel {
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: 100%;
  border-top: 1px solid var(--border);
  background: color-mix(in srgb, var(--surface-solid, #111) 92%, #000);
}

.terminal-tabs {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  height: 32px;
  padding: 0 6px 0 4px;
  border-bottom: 1px solid color-mix(in srgb, var(--border) 80%, transparent);
  background: color-mix(in srgb, var(--surface) 88%, #000);
  flex-shrink: 0;
}

.tab-list {
  display: flex;
  align-items: center;
  gap: 2px;
  min-width: 0;
  overflow-x: auto;
}

.tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 180px;
  height: 26px;
  border: 0;
  border-radius: 6px 6px 0 0;
  padding: 0 6px 0 8px;
  background: transparent;
  color: var(--text-muted);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}

.tab.active {
  background: #000;
  color: var(--text);
}

.tab.exited {
  opacity: 0.65;
}

.tab-icon {
  width: 14px;
  height: 14px;
  display: inline-flex;
  color: inherit;
  flex-shrink: 0;
}

.tab-icon svg {
  width: 14px;
  height: 14px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.3;
}

.tab-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tab-close,
.tab-action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border: 0;
  border-radius: 4px;
  padding: 0;
  background: transparent;
  color: var(--text-muted);
  font: inherit;
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
  flex-shrink: 0;
}

.tab-close:hover,
.tab-action:hover {
  color: var(--text);
  background: var(--surface-hover);
}

.panel-close {
  margin-left: auto;
}

.terminal-body {
  position: relative;
  flex: 1;
  min-height: 0;
  background: #000;
}

.empty {
  margin: 0;
  padding: 12px;
  color: var(--text-muted);
  font-size: 12px;
}
</style>
