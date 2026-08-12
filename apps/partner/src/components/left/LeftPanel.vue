<script setup lang="ts">
import { storeToRefs } from "pinia";
import { computed } from "vue";
import SessionHistoryMenu from "@/components/chat/SessionHistoryMenu.vue";
import SessionSearchDialog from "@/components/chat/SessionSearchDialog.vue";
import ProjectSessionTree from "@/components/left/ProjectSessionTree.vue";
import PanelToggleButton from "@/components/ui/PanelToggleButton.vue";
import { useAppStateStore } from "@/stores/app-state";
import { useChatStore } from "@/stores/chat";
import { useSettingsStore } from "@/stores/settings";
import { useTerminalStore } from "@/stores/terminal";
import { useWorkspaceStore } from "@/stores/workspace";
import { resolveSessionCwd } from "@/utils/session-cwd";

const emit = defineEmits<{
  collapse: [];
}>();

const appState = useAppStateStore();
const chat = useChatStore();
const settings = useSettingsStore();
const terminal = useTerminalStore();
const workspace = useWorkspaceStore();
const { previewProject } = storeToRefs(appState);
const { open: terminalOpen } = storeToRefs(terminal);

const uiText = computed(() =>
  settings.locale === "en"
    ? {
        newChat: "New chat",
        openFolder: "Open folder to add a project",
        collapse: "Collapse sidebar",
        terminal: "Terminal",
      }
    : {
        newChat: "新对话",
        openFolder: "打开文件夹以添加项目",
        collapse: "收起侧栏",
        terminal: "终端",
      },
);

const terminalButtonTitle = computed(() => {
  const shortcut =
    typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform)
      ? "⌘`"
      : "Ctrl+`";
  const cwd = resolveSessionCwd({
    activeTabId: appState.activeTabId,
    sessions: appState.sessions,
    projects: appState.projects,
    workspaceRootPath: workspace.rootPath,
  });
  const project =
    cwd.cwd && cwd.label !== "Terminal" ? cwd.label : "";
  const base = project
    ? `${uiText.value.terminal} · ${project}`
    : uiText.value.terminal;
  return `${base} (${shortcut})`;
});

/**
 * Activate a session.
 *
 * Only the Host is written: the workspace root, preview project and preview
 * snapshot all follow the Host patch. Setting the root here instead used to
 * re-trigger the projection while this activation was still in flight, which
 * reverted the click.
 */
function selectSession(sessionId: string) {
  const session = appState.getSession(sessionId);
  if (!session) return;
  void appState.openSession(sessionId);
  chat.ensureSessionTab(session);
}

function createSession(projectId: string | null) {
  void (async () => {
    const id = await appState.createSession({ projectId });
    const session = appState.getSession(id);
    if (session) chat.ensureSessionTab(session);
  })();
}

function onNewChat() {
  // Top-bar "+" creates an unscoped session at the root; per-project "+" stays on each row.
  createSession(null);
}

function toggleTerminal() {
  terminal.toggle();
}

</script>

<template>
  <aside class="left-panel" data-shortcut-scope="left">
    <header class="left-header">
      <PanelToggleButton
        side="left"
        :open="true"
        :title="uiText.collapse"
        @click="emit('collapse')"
      />
      <div class="header-actions">
        <SessionSearchDialog />
        <SessionHistoryMenu />
        <button
          type="button"
          class="header-icon-button"
          :class="{ active: terminalOpen }"
          :title="terminalButtonTitle"
          :aria-label="terminalButtonTitle"
          :aria-pressed="terminalOpen"
          @click="toggleTerminal"
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <rect x="1.5" y="3" width="13" height="10" rx="1.2" />
            <path d="M4 6.5h3.5M4 9h5" />
          </svg>
        </button>
        <button
          type="button"
          class="new-chat-button"
          :title="uiText.newChat"
          :aria-label="uiText.newChat"
          @click="onNewChat"
        >
          +
        </button>
      </div>
    </header>

    <ProjectSessionTree
      @select-session="selectSession"
      @new-session="createSession"
    />

    <footer v-if="!previewProject" class="left-footer">
      {{ uiText.openFolder }}
    </footer>
  </aside>
</template>

<style scoped>
.left-panel {
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: 100%;
  background: var(--bg);
  border-right: 1px solid var(--border);
  overflow: hidden;
}

.left-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-shrink: 0;
  height: 36px;
  padding: 0 8px 0 6px;
  border-bottom: 1px solid var(--border);
}

.header-actions {
  display: inline-flex;
  align-items: center;
  gap: 2px;
}

.header-actions :deep(.search-button),
.header-actions :deep(.history-button) {
  width: 28px;
  height: 28px;
  border-radius: 5px;
}

.header-icon-button,
.new-chat-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
}

.new-chat-button {
  font-size: 16px;
  line-height: 1;
}

.header-icon-button svg {
  width: 15px;
  height: 15px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.3;
}

.header-icon-button:hover,
.header-icon-button.active,
.new-chat-button:hover {
  background: var(--surface-hover);
  color: var(--text);
}

.left-footer {
  flex-shrink: 0;
  padding: 8px 12px 12px;
  border-top: 1px solid var(--border);
  color: var(--text-muted);
  font-size: 11px;
  line-height: 1.4;
}
</style>
