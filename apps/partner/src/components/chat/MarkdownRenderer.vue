<script setup lang="ts">
import { computed } from "vue";
import { renderMarkdown } from "@/utils/markdown";

const props = defineProps<{
  content: string;
}>();

const rendered = computed(() => renderMarkdown(props.content));
</script>

<template>
  <div class="markdown-renderer" v-html="rendered" />
</template>

<style scoped>
.markdown-renderer {
  color: var(--text);
  font-size: 14px;
  line-height: 1.65;
  word-break: break-word;
}

.markdown-renderer :deep(*) {
  margin-top: 0;
}

.markdown-renderer :deep(*:last-child) {
  margin-bottom: 0;
}

.markdown-renderer :deep(p) {
  margin: 0 0 10px;
}

.markdown-renderer :deep(ul),
.markdown-renderer :deep(ol) {
  margin: 0 0 10px;
  padding-left: 22px;
}

.markdown-renderer :deep(li + li) {
  margin-top: 4px;
}

.markdown-renderer :deep(blockquote) {
  margin: 0 0 10px;
  padding-left: 12px;
  border-left: 3px solid var(--border);
  color: var(--text-muted);
}

.markdown-renderer :deep(pre) {
  margin: 0 0 10px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface-elevated);
  overflow-x: auto;
}

.markdown-renderer :deep(code) {
  border-radius: 4px;
  padding: 1px 4px;
  background: var(--surface-elevated);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 0.92em;
}

.markdown-renderer :deep(pre code) {
  padding: 0;
  background: transparent;
}

.markdown-renderer :deep(a) {
  color: var(--accent);
  text-decoration: none;
}

.markdown-renderer :deep(a:hover) {
  text-decoration: underline;
}

.markdown-renderer :deep(table) {
  display: block;
  width: 100%;
  margin: 0 0 10px;
  border-collapse: collapse;
  overflow-x: auto;
}

.markdown-renderer :deep(th),
.markdown-renderer :deep(td) {
  border: 1px solid var(--border);
  padding: 6px 8px;
}

.markdown-renderer :deep(hr) {
  display: none;
}
</style>
