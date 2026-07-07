<script setup lang="ts">
import type { GitChange } from "@/types";

export interface GitSummary {
  branch: string;
  upstream: string;
  ahead: number;
  behind: number;
  rebasing: boolean;
  loading?: boolean;
  actionRunning?: boolean;
  error?: string;
}

defineProps<{
  changes: GitChange[];
  summary?: GitSummary;
}>();

defineEmits<{
  refresh: [];
  fetch: [];
  pullRebase: [];
  rebaseContinue: [];
  rebaseAbort: [];
  openDiff: [change: GitChange];
}>();
</script>

<template>
  <section class="git-changes">
    <div v-if="summary" class="git-summary">
      <div class="branch-row">
        <span class="branch-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24">
            <circle cx="6" cy="5" r="2.2" />
            <circle cx="18" cy="5" r="2.2" />
            <circle cx="12" cy="19" r="2.2" />
            <path d="M6 7.2v3.3c0 2.1 1.7 3.8 3.8 3.8H12" />
            <path d="M18 7.2v3.3c0 2.1-1.7 3.8-3.8 3.8H12v2.5" />
          </svg>
        </span>
        <span class="branch-name">{{ summary.branch || "HEAD" }}</span>
        <span v-if="summary.upstream" class="upstream">{{ summary.upstream }}</span>
        <button
          type="button"
          class="icon-action"
          title="刷新 Git 状态"
          :disabled="summary.loading || summary.actionRunning"
          @click="$emit('refresh')"
        >
          ↻
        </button>
      </div>
      <div class="sync-row">
        <span class="sync-count">↓ {{ summary.behind }}</span>
        <span class="sync-count">↑ {{ summary.ahead }}</span>
        <button
          type="button"
          class="git-action"
          :disabled="summary.actionRunning || !summary.upstream"
          @click="$emit('fetch')"
        >
          Fetch
        </button>
        <button
          type="button"
          class="git-action"
          :disabled="summary.actionRunning || !summary.upstream"
          @click="$emit('pullRebase')"
        >
          Pull rebase
        </button>
      </div>
      <div v-if="summary.rebasing" class="rebase-row">
        <span>Rebase 进行中</span>
        <button type="button" class="git-action" :disabled="summary.actionRunning" @click="$emit('rebaseContinue')">
          Continue
        </button>
        <button type="button" class="git-action danger" :disabled="summary.actionRunning" @click="$emit('rebaseAbort')">
          Abort
        </button>
      </div>
      <p v-if="summary.error" class="git-error">{{ summary.error }}</p>
    </div>
    <ul v-if="changes.length">
      <li v-for="change in changes" :key="change.path">
        <span class="status">{{ change.status }}</span>
        <button type="button" class="path-button" :title="change.path" @click="$emit('openDiff', change)">
          {{ change.path }}
        </button>
      </li>
    </ul>
    <p v-else class="empty">暂无变更</p>
  </section>
</template>

<style scoped>
.git-changes {
  margin-top: 8px;
}

.git-summary {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 0 8px 10px;
  padding: 8px;
  border: 1px solid color-mix(in srgb, var(--border) 76%, transparent);
  border-radius: 10px;
  background: color-mix(in srgb, var(--surface-elevated) 76%, transparent);
  font-size: 12px;
}

.branch-row,
.sync-row,
.rebase-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.branch-icon {
  display: inline-flex;
  width: 16px;
  height: 16px;
  color: var(--text-muted);
}

.branch-icon svg {
  fill: none;
  stroke: currentColor;
  stroke-width: 1.8;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.branch-name {
  min-width: 0;
  color: var(--text);
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.upstream {
  min-width: 0;
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sync-count {
  color: var(--text-muted);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}

.icon-action,
.git-action {
  border: 1px solid var(--border);
  border-radius: 7px;
  padding: 2px 7px;
  background: var(--surface);
  color: var(--text);
  font: inherit;
  cursor: pointer;
}

.icon-action {
  margin-left: auto;
}

.git-action:hover:not(:disabled),
.icon-action:hover:not(:disabled) {
  background: var(--surface-hover);
}

.git-action:disabled,
.icon-action:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.git-action.danger {
  color: #ff9a9a;
}

.git-error {
  margin: 0;
  color: #ff9a9a;
  font-size: 12px;
}

ul {
  list-style: none;
  margin: 0;
  padding: 0;
}

li {
  display: flex;
  gap: 8px;
  padding: 4px 0;
  font-size: 12px;
}

.status {
  color: var(--accent);
  font-family: monospace;
  min-width: 24px;
}

.path-button {
  min-width: 0;
  border: none;
  padding: 0;
  background: transparent;
  color: var(--text);
  font: inherit;
  text-align: left;
  cursor: pointer;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.path-button:hover {
  color: var(--accent);
}

.empty {
  margin: 0;
  font-size: 12px;
  color: var(--text-muted);
}
</style>
