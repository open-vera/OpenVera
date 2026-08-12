<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { lspStatus, type LspServerStatus } from "@/bridge/lsp";
import PartnerSelect from "@/components/ui/PartnerSelect.vue";
import {
  EDITOR_TAB_SIZES,
  MAX_EDITOR_FONT_SIZE,
  MIN_EDITOR_FONT_SIZE,
} from "@/preview/editor-preferences";
import { usePreviewStore } from "@/stores/preview";
import { useSettingsStore } from "@/stores/settings";

/** LSP servers start lazily; poll while the panel is visible. */
const STATUS_POLL_MS = 4000;

const settings = useSettingsStore();
const preview = usePreviewStore();

const servers = ref<LspServerStatus[]>([]);
const isLoading = ref(false);
const error = ref("");
let pollTimer: ReturnType<typeof setInterval> | undefined;

const copy = computed(() => {
  if (settings.locale === "en") {
    return {
      title: "Editor",
      hint: "Applies to every code tab in the preview panel.",
      fontSize: "Font size",
      fontSizeHint: `${MIN_EDITOR_FONT_SIZE}–${MAX_EDITOR_FONT_SIZE} px`,
      tabSize: "Tab width",
      tabSizeHint: "Spaces per indent level",
      wordWrap: "Word wrap",
      wordWrapHint: "Off keeps long lines on one line and scrolls horizontally",
      minimap: "Minimap",
      minimapHint: "Floating overview on the right edge",
      lineNumbers: "Line numbers",
      lineNumbersHint: "Show the gutter",
      reset: "Reset to defaults",
      lspTitle: "Language servers",
      lspHint: "Servers start on demand when you open a matching file.",
      lspToggle: "Enable LSP",
      lspToggleHint:
        "Off disables completion, diagnostics and go-to-definition",
      refresh: "Refresh",
      loading: "Checking…",
      running: "Running",
      stopped: "Not started",
      crashed: "Exited",
      port: "port",
      pid: "pid",
      uptime: "up",
      on: "On",
      off: "Off",
    };
  }
  return {
    title: "编辑器",
    hint: "对预览区的所有代码页签生效。",
    fontSize: "字号",
    fontSizeHint: `${MIN_EDITOR_FONT_SIZE}–${MAX_EDITOR_FONT_SIZE} px`,
    tabSize: "Tab 宽度",
    tabSizeHint: "每级缩进的空格数",
    wordWrap: "自动换行",
    wordWrapHint: "关闭时长行不折行，改为横向滚动",
    minimap: "缩略图",
    minimapHint: "右侧悬浮的代码概览",
    lineNumbers: "行号",
    lineNumbersHint: "显示左侧行号栏",
    reset: "恢复默认",
    lspTitle: "语言服务",
    lspHint: "打开对应类型的文件时按需启动。",
    lspToggle: "启用 LSP",
    lspToggleHint: "关闭后没有补全、诊断与跳转定义",
    refresh: "刷新",
    loading: "检测中…",
    running: "运行中",
    stopped: "未启动",
    crashed: "已退出",
    port: "端口",
    pid: "进程",
    uptime: "已运行",
    on: "开",
    off: "关",
  };
});

const tabSizeOptions = computed(() =>
  EDITOR_TAB_SIZES.map((size) => ({ value: String(size), label: String(size) }))
);

function statusLabel(server: LspServerStatus): string {
  if (server.running) return copy.value.running;
  return server.exitCode === undefined
    ? copy.value.stopped
    : copy.value.crashed;
}

function statusKind(
  server: LspServerStatus
): "running" | "stopped" | "crashed" {
  if (server.running) return "running";
  return server.exitCode === undefined ? "stopped" : "crashed";
}

function uptimeLabel(server: LspServerStatus): string {
  if (!server.running || !server.startedAt) return "";
  const seconds = Math.max(
    0,
    Math.round((Date.now() - server.startedAt) / 1000)
  );
  if (seconds < 60) return `${copy.value.uptime} ${seconds}s`;
  if (seconds < 3600)
    return `${copy.value.uptime} ${Math.floor(seconds / 60)}m`;
  return `${copy.value.uptime} ${Math.floor(seconds / 3600)}h`;
}

async function refresh() {
  if (isLoading.value) return;
  isLoading.value = true;
  try {
    servers.value = await lspStatus();
    error.value = "";
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    isLoading.value = false;
  }
}

function onFontSizeInput(event: Event) {
  const value = Number((event.target as HTMLInputElement).value);
  settings.setEditorPreference("fontSize", value);
}

onMounted(() => {
  void refresh();
  pollTimer = setInterval(() => void refresh(), STATUS_POLL_MS);
});

onBeforeUnmount(() => {
  if (pollTimer) clearInterval(pollTimer);
});

defineExpose({ refresh });
</script>

<template>
  <section class="settings-section">
    <div class="section-heading">
      <strong>{{ copy.title }}</strong>
      <small>{{ copy.hint }}</small>
    </div>

    <div class="settings-card">
      <div class="setting-row">
        <span class="setting-label">
          <strong>{{ copy.fontSize }}</strong>
          <small>{{ copy.fontSizeHint }}</small>
        </span>
        <span class="slider-control">
          <input
            type="range"
            :min="MIN_EDITOR_FONT_SIZE"
            :max="MAX_EDITOR_FONT_SIZE"
            step="1"
            :value="settings.editor.fontSize"
            :aria-label="copy.fontSize"
            @input="onFontSizeInput"
          />
          <span class="slider-value">{{ settings.editor.fontSize }}px</span>
        </span>
      </div>

      <div class="setting-row">
        <span class="setting-label">
          <strong>{{ copy.tabSize }}</strong>
          <small>{{ copy.tabSizeHint }}</small>
        </span>
        <PartnerSelect
          :model-value="String(settings.editor.tabSize)"
          :options="tabSizeOptions"
          :aria-label="copy.tabSize"
          @update:model-value="
            settings.setEditorPreference('tabSize', Number($event))
          "
        />
      </div>

      <div class="setting-row">
        <span class="setting-label">
          <strong>{{ copy.wordWrap }}</strong>
          <small>{{ copy.wordWrapHint }}</small>
        </span>
        <label class="switch">
          <input
            type="checkbox"
            :checked="settings.editor.wordWrap"
            @change="
              settings.setEditorPreference(
                'wordWrap',
                ($event.target as HTMLInputElement).checked
              )
            "
          />
          <span>{{ settings.editor.wordWrap ? copy.on : copy.off }}</span>
        </label>
      </div>

      <div class="setting-row">
        <span class="setting-label">
          <strong>{{ copy.minimap }}</strong>
          <small>{{ copy.minimapHint }}</small>
        </span>
        <label class="switch">
          <input
            type="checkbox"
            :checked="settings.editor.minimap"
            @change="
              settings.setEditorPreference(
                'minimap',
                ($event.target as HTMLInputElement).checked
              )
            "
          />
          <span>{{ settings.editor.minimap ? copy.on : copy.off }}</span>
        </label>
      </div>

      <div class="setting-row">
        <span class="setting-label">
          <strong>{{ copy.lineNumbers }}</strong>
          <small>{{ copy.lineNumbersHint }}</small>
        </span>
        <label class="switch">
          <input
            type="checkbox"
            :checked="settings.editor.lineNumbers"
            @change="
              settings.setEditorPreference(
                'lineNumbers',
                ($event.target as HTMLInputElement).checked
              )
            "
          />
          <span>{{ settings.editor.lineNumbers ? copy.on : copy.off }}</span>
        </label>
      </div>

      <div class="setting-row">
        <span class="setting-label">
          <strong>{{ copy.lspToggle }}</strong>
          <small>{{ copy.lspToggleHint }}</small>
        </span>
        <label class="switch">
          <input
            type="checkbox"
            :checked="preview.lspEnabled"
            @change="
              preview.setLspEnabled(($event.target as HTMLInputElement).checked)
            "
          />
          <span>{{ preview.lspEnabled ? copy.on : copy.off }}</span>
        </label>
      </div>

      <div class="setting-row card-footer">
        <button
          type="button"
          class="link-button"
          @click="settings.resetEditorPreferences()"
        >
          {{ copy.reset }}
        </button>
      </div>
    </div>

    <div class="section-heading lsp-heading">
      <div class="section-heading-row">
        <strong>{{ copy.lspTitle }}</strong>
        <button
          type="button"
          class="link-button"
          :disabled="isLoading"
          @click="refresh"
        >
          {{ isLoading ? copy.loading : copy.refresh }}
        </button>
      </div>
      <small>{{ copy.lspHint }}</small>
    </div>

    <div class="settings-card">
      <p v-if="error" class="status error">{{ error }}</p>
      <p v-else-if="!servers.length && isLoading" class="status">
        {{ copy.loading }}
      </p>
      <ul v-else class="lsp-list">
        <li v-for="server in servers" :key="server.languageId" class="lsp-row">
          <span class="lsp-main">
            <span class="lsp-language">
              <span
                class="lsp-dot"
                :class="statusKind(server)"
                aria-hidden="true"
              />
              <strong>{{ server.languageId }}</strong>
            </span>
            <span class="lsp-state" :class="statusKind(server)">
              {{ statusLabel(server) }}
              <template v-if="server.exitCode !== undefined">
                ({{ server.exitCode }})
              </template>
            </span>
          </span>
          <span class="lsp-meta">
            <template v-if="server.running">
              <span v-if="server.port">{{ copy.port }} {{ server.port }}</span>
              <span v-if="server.pid">{{ copy.pid }} {{ server.pid }}</span>
              <span v-if="uptimeLabel(server)">{{ uptimeLabel(server) }}</span>
            </template>
          </span>
          <code class="lsp-command" :title="server.command">{{
            server.command
          }}</code>
        </li>
      </ul>
    </div>
  </section>
</template>

<style scoped>
/* Mirrors the shared settings primitives; the parent's scoped styles reach this
   component's root element only, not its children. */
.settings-section {
  width: min(100%, 780px);
  margin-bottom: 28px;
}

.section-heading {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-bottom: 10px;
}

.section-heading-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.section-heading strong {
  font-size: 13px;
  font-weight: 650;
}

.section-heading small {
  color: var(--text-muted);
  font-size: 12px;
}

.lsp-heading {
  margin-top: 18px;
}

.settings-card {
  width: 100%;
  padding: 4px 14px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface-elevated);
}

.setting-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 12px 0;
  border-bottom: 1px solid color-mix(in srgb, var(--text) 8%, transparent);
}

.setting-row:last-child {
  border-bottom: none;
}

.setting-label {
  display: flex;
  flex-direction: column;
  gap: 2px;
  /* Grow, and never let the control column squeeze the label into one
     character per line. */
  flex: 1 1 auto;
  min-width: 96px;
}

.setting-label strong {
  font-size: 13px;
  font-weight: 600;
}

.setting-label small {
  color: var(--text-muted);
  font-size: 11px;
}

.setting-row > :not(.setting-label) {
  flex: 0 0 auto;
}

.card-footer {
  justify-content: flex-end;
}

.slider-control {
  display: inline-flex;
  align-items: center;
  gap: 10px;
}

.slider-control input {
  width: 140px;
}

.slider-value {
  min-width: 44px;
  color: var(--text-muted);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  text-align: right;
}

.switch {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  color: var(--text-muted);
  font-size: 12px;
  cursor: pointer;
}

.link-button {
  flex-shrink: 0;
  border: none;
  padding: 0;
  background: transparent;
  color: var(--text-muted);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}

.link-button:hover:not(:disabled) {
  color: var(--accent);
}

.link-button:disabled {
  opacity: 0.5;
  cursor: default;
}

.status {
  margin: 12px 0;
  color: var(--accent);
  font-size: 12px;
}

.status.error {
  color: var(--danger-muted);
}

.lsp-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin: 12px 0;
  padding: 0;
  list-style: none;
}

.lsp-row {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.lsp-main {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
}

.lsp-language {
  display: inline-flex;
  align-items: baseline;
  gap: 7px;
}

.lsp-language strong {
  font-size: 13px;
  font-weight: 600;
}

.lsp-dot {
  width: 7px;
  height: 7px;
  flex-shrink: 0;
  border-radius: 999px;
  background: var(--text-muted);
}

.lsp-dot.running {
  background: var(--success, #4ade80);
}

.lsp-dot.crashed {
  background: var(--danger-muted, #f87171);
}

.lsp-state {
  color: var(--text-muted);
  font-size: 11px;
  white-space: nowrap;
}

.lsp-state.running {
  color: var(--text);
}

.lsp-state.crashed {
  color: var(--danger-muted);
}

.lsp-meta {
  display: flex;
  gap: 12px;
  color: var(--text-muted);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

.lsp-command {
  overflow: hidden;
  color: var(--text-muted);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
