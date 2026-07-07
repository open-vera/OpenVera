<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { Message } from "@/types";
import { attachmentLabel } from "@/utils/attachments";
import MarkdownRenderer from "./MarkdownRenderer.vue";

const props = defineProps<{
  message: Message;
}>();

const expanded = ref(false);
const assistantLines = computed(() => props.message.content.split(/\n+/).filter((line) => line.trim()));
const shouldCollapseAssistant = computed(() =>
  props.message.role === "assistant" &&
  !props.message.isError &&
  props.message.isStreaming &&
  assistantLines.value.length > 1,
);
const isAssistantCollapsed = computed(() => shouldCollapseAssistant.value && !expanded.value);
const renderedAssistantContent = computed(() => {
  if (!isAssistantCollapsed.value) return props.message.content || "…";
  const lines = assistantLines.value;
  if (props.message.isStreaming) {
    const latest = lines.at(-1);
    return latest || props.message.content || "…";
  }
  return props.message.content || "…";
});
const collapsedLabel = computed(() => {
  return "已折叠运行过程，只显示最新内容";
});
const toggleText = computed(() => (expanded.value ? "收起" : "展开全部"));

watch(
  () => props.message.id,
  () => {
    expanded.value = false;
  },
);
</script>

<template>
  <article class="bubble" :class="[message.role, { error: message.isError }]">
    <div v-if="message.role === 'assistant'" class="content markdown-content">
      <div v-if="message.isError" class="error-heading">运行失败</div>
      <div v-if="isAssistantCollapsed" class="assistant-collapse-note">
        <span>...</span>
        <span>{{ collapsedLabel }}</span>
      </div>
      <MarkdownRenderer v-if="renderedAssistantContent" :content="renderedAssistantContent" />
      <button
        v-if="shouldCollapseAssistant"
        type="button"
        class="assistant-toggle"
        @click="expanded = !expanded"
      >
        {{ toggleText }}
      </button>
    </div>
    <div v-else class="content">
      {{ message.content || "…" }}
      <div v-if="message.attachments?.length" class="message-attachments">
        <span
          v-for="attachment in message.attachments"
          :key="attachment.id"
          class="message-attachment"
          :title="attachmentLabel(attachment)"
        >
          <span class="attachment-kind">{{ attachment.kind === "image" ? "IMG" : "FILE" }}</span>
          <span class="attachment-name">{{ attachment.name }}</span>
        </span>
      </div>
    </div>
  </article>
</template>

<style scoped>
.bubble {
  max-width: min(86%, 860px);
  padding: 10px 13px;
  border-radius: 14px;
  font-size: 14px;
  line-height: 1.5;
}

.bubble.user {
  align-self: flex-end;
  background: color-mix(in srgb, var(--surface-hover) 78%, var(--bg));
  border: 1px solid color-mix(in srgb, var(--border) 70%, transparent);
  color: var(--text);
}

.bubble.assistant {
  align-self: flex-start;
  width: min(92%, 900px);
  max-width: min(92%, 900px);
  padding: 0;
  background: transparent;
  border: none;
}

.bubble.assistant.error {
  padding: 12px 14px;
  border: 1px solid color-mix(in srgb, #ff6b6b 58%, var(--border));
  border-radius: 14px;
  background: color-mix(in srgb, #ff6b6b 10%, var(--surface-elevated));
}

.bubble.tool {
  align-self: flex-start;
  background: var(--surface);
  border: 1px dashed var(--border);
  font-family: monospace;
  font-size: 12px;
}

.content {
  white-space: pre-wrap;
  word-break: break-word;
}

.markdown-content {
  white-space: normal;
}

.markdown-content :deep(hr) {
  display: none;
}

.error-heading {
  margin-bottom: 8px;
  color: #ff8a8a;
  font-weight: 700;
}

.assistant-collapse-note {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
  color: var(--text-muted);
  font-size: 12px;
}

.assistant-collapse-note span:first-child {
  font-weight: 700;
  letter-spacing: 0.08em;
}

.assistant-toggle {
  margin-top: 6px;
  border: none;
  padding: 0;
  background: transparent;
  color: var(--accent);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}

.assistant-toggle:hover {
  text-decoration: underline;
}

.message-attachments {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
}

.message-attachment {
  display: inline-flex;
  align-items: center;
  max-width: 280px;
  height: 26px;
  border: 1px solid color-mix(in srgb, var(--border) 80%, transparent);
  border-radius: 999px;
  background: color-mix(in srgb, var(--surface) 72%, transparent);
  color: var(--text);
  font-size: 12px;
  overflow: hidden;
}

.attachment-kind {
  flex-shrink: 0;
  padding: 0 7px;
  color: var(--text-muted);
  font-size: 10px;
  letter-spacing: 0.04em;
}

.attachment-name {
  min-width: 0;
  padding-right: 9px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
