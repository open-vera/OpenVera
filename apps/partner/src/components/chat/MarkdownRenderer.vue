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
  overflow-wrap: anywhere;
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
  margin: 0 0 12px;
  padding-left: 24px;
}

.markdown-renderer :deep(li + li) {
  margin-top: 5px;
}

.markdown-renderer :deep(li > p) {
  margin-bottom: 6px;
}

.markdown-renderer :deep(li::marker) {
  color: var(--accent);
  font-weight: 700;
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
  border: 1px solid color-mix(in srgb, var(--border) 82%, transparent);
  border-radius: 8px;
  background: var(--surface-elevated);
  overflow-x: auto;
  white-space: pre;
}

.markdown-renderer :deep(code) {
  border: 1px solid color-mix(in srgb, var(--border) 55%, transparent);
  border-radius: 4px;
  padding: 1px 5px;
  background: color-mix(in srgb, var(--surface-elevated) 86%, transparent);
  color: color-mix(in srgb, var(--text) 94%, var(--accent));
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 0.92em;
}

.markdown-renderer :deep(pre code) {
  border: none;
  padding: 0;
  color: inherit;
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
  margin: 2px 0 12px;
  border-collapse: separate;
  border-spacing: 0;
  overflow-x: auto;
}

.markdown-renderer :deep(th),
.markdown-renderer :deep(td) {
  border: 1px solid var(--border);
  padding: 7px 9px;
  vertical-align: top;
}

.markdown-renderer :deep(th) {
  background: color-mix(in srgb, var(--surface-elevated) 78%, var(--surface));
  color: var(--text);
  font-weight: 650;
}

.markdown-renderer :deep(td) {
  color: color-mix(in srgb, var(--text) 92%, var(--text-muted));
}

.markdown-renderer :deep(hr) {
  display: none;
}
</style>
