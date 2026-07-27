<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { FileChange } from "@/types";
import { usePreviewStore } from "@/stores/preview";
import { formatChangeCounts } from "@/utils/turn-file-changes";

const props = defineProps<{
  changes: FileChange[];
}>();

const preview = usePreviewStore();
const expanded = ref(true);
const selectedPath = ref<string | null>(null);

const isZh = computed(() => navigator.language.toLowerCase().startsWith("zh"));
const selected = computed(
  () => props.changes.find((item) => item.path === selectedPath.value) ?? null,
);

watch(
  () => props.changes.map((item) => item.path).join("\0"),
  () => {
    if (selectedPath.value && !props.changes.some((item) => item.path === selectedPath.value)) {
      selectedPath.value = null;
    }
  },
);

function toggleExpanded() {
  expanded.value = !expanded.value;
}

function selectFile(change: FileChange) {
  selectedPath.value = selectedPath.value === change.path ? null : change.path;
}

function openInPreview(change: FileChange) {
  preview.openDiffFile(change.path, change.unifiedDiff);
}

function diffLines(unifiedDiff: string): Array<{ kind: "add" | "del" | "meta" | "ctx"; text: string }> {
  return unifiedDiff.split(/\r?\n/).map((line) => {
    if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff ") || line.startsWith("@@")) {
      return { kind: "meta" as const, text: line };
    }
    if (line.startsWith("+")) return { kind: "add" as const, text: line };
    if (line.startsWith("-")) return { kind: "del" as const, text: line };
    return { kind: "ctx" as const, text: line };
  });
}
</script>

<template>
  <section v-if="changes.length" class="turn-changes">
    <div v-if="expanded && selected" class="diff-card">
      <header class="diff-card-header">
        <span class="diff-path" :title="selected.path">{{ selected.path }}</span>
        <span class="counts">
          <span class="added">+{{ selected.added }}</span>
          <span class="removed">-{{ selected.removed }}</span>
        </span>
        <button type="button" class="open-preview" @click="openInPreview(selected)">
          {{ isZh ? "预览" : "Preview" }}
        </button>
        <button type="button" class="close-diff" @click="selectedPath = null" :aria-label="isZh ? '关闭' : 'Close'">
          ×
        </button>
      </header>
      <pre class="diff-body"><code><span
          v-for="(line, index) in diffLines(selected.unifiedDiff)"
          :key="index"
          class="diff-line"
          :class="line.kind"
        >{{ line.text }}</span></code></pre>
    </div>

    <ul v-if="expanded" class="file-list">
      <li v-for="change in changes" :key="change.path">
        <button
          type="button"
          class="file-row"
          :class="{ active: selectedPath === change.path }"
          :title="change.path"
          @click="selectFile(change)"
        >
          <span class="file-path">{{ change.path }}</span>
          <span class="counts">
            <span class="added">+{{ change.added }}</span>
            <span class="removed">-{{ change.removed }}</span>
          </span>
        </button>
      </li>
    </ul>

    <button type="button" class="toggle" @click="toggleExpanded">
      <span class="chevron" :class="{ open: expanded }" aria-hidden="true">▾</span>
      {{
        expanded
          ? isZh
            ? "收起文件"
            : "Collapse files"
          : isZh
            ? `本轮变更 ${changes.length} 个文件`
            : `${changes.length} files changed`
      }}
      <span v-if="!expanded" class="counts summary-counts">
        {{
          formatChangeCounts({
            added: changes.reduce((sum, item) => sum + item.added, 0),
            removed: changes.reduce((sum, item) => sum + item.removed, 0),
          })
        }}
      </span>
    </button>
  </section>
</template>

<style scoped>
.turn-changes {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 4px 12px 10px;
  max-width: min(720px, 100%);
}

.diff-card {
  border: 1px solid color-mix(in srgb, var(--border) 80%, transparent);
  border-radius: 10px;
  background: color-mix(in srgb, var(--surface-elevated, var(--bg)) 92%, #000 8%);
  overflow: hidden;
  box-shadow: 0 10px 28px color-mix(in srgb, #000 28%, transparent);
}

.diff-card-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-bottom: 1px solid color-mix(in srgb, var(--border) 70%, transparent);
  font-size: 12px;
}

.diff-path {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}

.open-preview,
.close-diff {
  border: none;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  font-size: 12px;
  padding: 2px 6px;
  border-radius: 6px;
}

.open-preview:hover,
.close-diff:hover {
  background: color-mix(in srgb, var(--border) 40%, transparent);
  color: var(--text);
}

.close-diff {
  font-size: 16px;
  line-height: 1;
}

.diff-body {
  margin: 0;
  max-height: 280px;
  overflow: auto;
  padding: 8px 0;
  font-size: 12px;
  line-height: 1.45;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}

.diff-line {
  display: block;
  padding: 0 10px;
  white-space: pre-wrap;
  word-break: break-word;
}

.diff-line.add {
  background: color-mix(in srgb, #3fb950 18%, transparent);
  color: color-mix(in srgb, #3fb950 70%, var(--text));
}

.diff-line.del {
  background: color-mix(in srgb, #f85149 18%, transparent);
  color: color-mix(in srgb, #f85149 70%, var(--text));
}

.diff-line.meta {
  color: var(--text-muted);
}

.file-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.file-row {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  text-align: left;
  border: 1px solid transparent;
  border-radius: 8px;
  background: transparent;
  color: var(--text);
  padding: 5px 8px;
  cursor: pointer;
}

.file-row:hover,
.file-row.active {
  background: color-mix(in srgb, var(--surface-elevated, var(--bg)) 88%, var(--border));
  border-color: color-mix(in srgb, var(--border) 60%, transparent);
}

.file-path {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}

.counts {
  display: inline-flex;
  gap: 6px;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  white-space: nowrap;
}

.added {
  color: #3fb950;
}

.removed {
  color: #f85149;
}

.toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  align-self: flex-start;
  border: none;
  background: transparent;
  color: var(--text-muted);
  font-size: 12px;
  cursor: pointer;
  padding: 2px 4px;
  border-radius: 6px;
}

.toggle:hover {
  color: var(--text);
  background: color-mix(in srgb, var(--border) 35%, transparent);
}

.chevron {
  display: inline-block;
  transform: rotate(-90deg);
  transition: transform 0.15s ease;
}

.chevron.open {
  transform: rotate(0deg);
}

.summary-counts {
  margin-left: 4px;
}
</style>
