<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { revealInOs, scanStorageUsage, type StorageEntry, type StorageUsageReport } from "@/bridge";
import { useSettingsStore } from "@/stores/settings";
import { useWorkspaceStore } from "@/stores/workspace";
import { formatBytes, formatFileCount, usageRatio } from "@/utils/format-bytes";

const settings = useSettingsStore();
const workspace = useWorkspaceStore();

const report = ref<StorageUsageReport | null>(null);
const isScanning = ref(false);
const error = ref("");

const copy = computed(() => {
  if (settings.locale === "en") {
    return {
      title: "Cache & storage",
      hint: "What Partner keeps on disk. Nothing here is deleted automatically — open a location to clean it up yourself.",
      refresh: "Rescan",
      scanning: "Scanning…",
      total: "Total",
      reveal: "Open",
      missing: "Not created yet",
      globalScope: "Global",
      projectScope: "This project",
      labels: {
        "app-state": "Sessions & window state",
        sessions: "Session transcripts (JSONL)",
        "run-logs": "Agent run logs (JSONL)",
        "app-logs": "App logs",
        memory: "Memory",
        settings: "Vera settings",
        sqlite: "SQLite databases",
        perf: "Performance traces",
        "legacy-sessions": "Legacy session file",
        "legacy-run-logs": "Legacy run logs",
      } as Record<string, string>,
    };
  }
  return {
    title: "缓存与存储",
    hint: "Partner 在磁盘上保留的数据。这里不会自动删除任何内容，需要清理请打开对应位置自行处理。",
    refresh: "重新扫描",
    scanning: "扫描中…",
    total: "合计",
    reveal: "打开",
    missing: "尚未生成",
    globalScope: "全局",
    projectScope: "当前项目",
    labels: {
      "app-state": "会话与窗口状态",
      sessions: "会话记录（JSONL）",
      "run-logs": "Agent 运行日志（JSONL）",
      "app-logs": "应用日志",
      memory: "记忆",
      settings: "Vera 配置",
      sqlite: "SQLite 数据库",
      perf: "性能埋点",
      "legacy-sessions": "旧版会话文件",
      "legacy-run-logs": "旧版运行日志",
    } as Record<string, string>,
  };
});

const rows = computed(() =>
  [...(report.value?.entries ?? [])].sort((a, b) => b.bytes - a.bytes),
);

function labelFor(entry: StorageEntry): string {
  return copy.value.labels[entry.id] ?? entry.id;
}

function scopeLabel(entry: StorageEntry): string {
  return entry.scope === "project" ? copy.value.projectScope : copy.value.globalScope;
}

function barWidth(entry: StorageEntry): string {
  return `${Math.round(usageRatio(entry.bytes, report.value?.totalBytes ?? 0) * 100)}%`;
}

async function scan() {
  if (isScanning.value) return;
  isScanning.value = true;
  error.value = "";
  try {
    report.value = await scanStorageUsage(workspace.rootPath || null);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    isScanning.value = false;
  }
}

async function open(entry: StorageEntry) {
  if (!entry.exists) return;
  try {
    await revealInOs(entry.path);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  }
}

onMounted(() => {
  void scan();
});

defineExpose({ scan });
</script>

<template>
  <section class="settings-section">
    <div class="section-heading">
      <div class="section-heading-row">
        <strong>{{ copy.title }}</strong>
        <button type="button" class="link-button" :disabled="isScanning" @click="scan">
          {{ isScanning ? copy.scanning : copy.refresh }}
        </button>
      </div>
      <small>{{ copy.hint }}</small>
    </div>

    <div class="settings-card storage-card">
      <p v-if="error" class="status error">{{ error }}</p>
      <p v-else-if="isScanning && !report" class="status">{{ copy.scanning }}</p>

      <ul v-if="report" class="storage-list">
        <li v-for="entry in rows" :key="entry.id" class="storage-row">
          <div class="storage-main">
            <span class="storage-label">
              <strong>{{ labelFor(entry) }}</strong>
              <small class="storage-scope">{{ scopeLabel(entry) }}</small>
            </span>
            <span class="storage-size">
              <strong>{{ formatBytes(entry.bytes) }}</strong>
              <small>{{
                entry.exists ? formatFileCount(entry.files, settings.locale) : copy.missing
              }}</small>
            </span>
          </div>
          <div class="storage-bar" aria-hidden="true">
            <span :style="{ width: barWidth(entry) }" />
          </div>
          <div class="storage-foot">
            <code class="storage-path" :title="entry.path">{{ entry.path }}</code>
            <button
              type="button"
              class="link-button"
              :disabled="!entry.exists"
              @click="open(entry)"
            >
              {{ copy.reveal }}
            </button>
          </div>
        </li>
      </ul>

      <div v-if="report" class="storage-total">
        <span>{{ copy.total }}</span>
        <strong>{{ formatBytes(report.totalBytes) }}</strong>
        <small>{{ formatFileCount(report.totalFiles, settings.locale) }}</small>
      </div>
    </div>
  </section>
</template>

<style scoped>
/* Mirrors the shared settings primitives; the parent's scoped styles reach
   this component's root element only, not its children. */
.settings-section {
  width: min(100%, 780px);
  margin-bottom: 20px;
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

.settings-card {
  width: 100%;
  padding: 14px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface-elevated);
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
  margin: 0;
  color: var(--accent);
  font-size: 12px;
}

.status.error {
  color: var(--danger-muted);
}

.storage-card {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.storage-list {
  display: flex;
  flex-direction: column;
  gap: 14px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.storage-row {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.storage-main {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
}

.storage-label {
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex: 1 1 auto;
  min-width: 0;
}

.storage-label strong {
  overflow: hidden;
  font-size: 13px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.storage-scope {
  flex: 0 0 auto;
  color: var(--text-muted);
  font-size: 11px;
  white-space: nowrap;
}

.storage-size {
  display: flex;
  align-items: baseline;
  gap: 8px;
  white-space: nowrap;
}

.storage-size strong {
  font-size: 13px;
  font-variant-numeric: tabular-nums;
}

.storage-size small,
.storage-total small {
  color: var(--text-muted);
  font-size: 11px;
}

.storage-bar {
  height: 4px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--text) 10%, transparent);
  overflow: hidden;
}

.storage-bar span {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: var(--accent, #6ea8fe);
}

.storage-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.storage-path {
  overflow: hidden;
  color: var(--text-muted);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.storage-total {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding-top: 10px;
  border-top: 1px solid color-mix(in srgb, var(--text) 12%, transparent);
  font-size: 12px;
}

.storage-total strong {
  font-size: 14px;
  font-variant-numeric: tabular-nums;
}
</style>
