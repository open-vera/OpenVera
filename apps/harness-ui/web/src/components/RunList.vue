<template>
  <div class="run-list">
    <div class="toolbar">
      <span class="title">Runs</span>
      <button class="btn-icon" :disabled="loading" @click="load" title="刷新">
        ↺
      </button>
    </div>

    <div v-if="error" class="error">{{ error }}</div>

    <div v-else-if="loading && runs.length === 0" class="empty">加载中…</div>

    <div v-else-if="runs.length === 0" class="empty">
      暂无运行记录
    </div>

    <ul v-else class="list">
      <li
        v-for="run in runs"
        :key="run.runId"
        class="item"
        :class="[run.status, { active: selected === run.runId }]"
        @click="$emit('select', run.runId)"
      >
        <div class="item-header">
          <span class="run-id">{{ run.runId.replace("iter-", "") }}</span>
          <span class="badge" :class="run.status">{{ statusLabel(run.status) }}</span>
        </div>
        <div v-if="run.goal" class="goal">{{ run.goal }}</div>
        <div class="meta">
          <span>{{ run.completedSteps }}/{{ run.totalSteps }} 步</span>
          <span v-if="run.failedSteps > 0" class="failed-count">{{ run.failedSteps }} 失败</span>
          <span class="dur">{{ formatDuration(run.durationMs) }}</span>
        </div>
      </li>
    </ul>
  </div>
</template>

<script setup lang="ts">
import type { RunSummary } from "../types";

defineProps<{ runs: RunSummary[]; loading: boolean; error?: string; selected?: string }>();
const emit = defineEmits<{ select: [runId: string]; refresh: [] }>();

function load() {
  emit("refresh");
}

function statusLabel(s: string) {
  return { running: "运行中", completed: "完成", failed: "失败", paused: "暂停" }[s] ?? s;
}

function formatDuration(ms?: number) {
  if (!ms) return "";
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}
</script>

<style scoped>
.run-list {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}

.toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
}

.title {
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--text-muted);
}

.btn-icon {
  background: none;
  border: none;
  cursor: pointer;
  color: var(--text-muted);
  font-size: 16px;
  padding: 2px 6px;
  border-radius: 4px;
}
.btn-icon:hover { background: var(--surface-2); color: var(--text); }
.btn-icon:disabled { opacity: 0.4; cursor: not-allowed; }

.error { padding: 12px 16px; color: var(--danger); font-size: 13px; }
.empty { padding: 32px 16px; text-align: center; color: var(--text-muted); font-size: 13px; }

.list {
  flex: 1;
  overflow-y: auto;
  list-style: none;
  margin: 0;
  padding: 0;
}

.item {
  padding: 10px 16px;
  cursor: pointer;
  border-bottom: 1px solid var(--border);
  border-left: 3px solid transparent;
  transition: background 0.1s;
}
.item:hover { background: var(--surface-2); }
.item.active { background: var(--surface-2); border-left-color: var(--accent); }
.item.completed { border-left-color: var(--success); }
.item.failed { border-left-color: var(--danger); }
.item.running { border-left-color: var(--accent); }
.item.paused { border-left-color: var(--warning); }

.item-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 4px;
}

.run-id {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-muted);
}

.goal {
  font-size: 13px;
  color: var(--text);
  margin-bottom: 4px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.meta {
  display: flex;
  gap: 10px;
  font-size: 11px;
  color: var(--text-muted);
}

.failed-count { color: var(--danger); }
.dur { margin-left: auto; }

.badge {
  font-size: 10px;
  font-weight: 600;
  padding: 1px 6px;
  border-radius: 10px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
.badge.running  { background: var(--accent-dim); color: var(--accent); }
.badge.completed { background: var(--success-dim); color: var(--success); }
.badge.failed   { background: var(--danger-dim); color: var(--danger); }
.badge.paused   { background: var(--warning-dim); color: var(--warning); }
</style>
