<script setup lang="ts">
import type { Message } from "@/types";
import { attachmentLabel } from "@/utils/attachments";
import MarkdownRenderer from "./MarkdownRenderer.vue";

defineProps<{
  message: Message;
}>();
</script>

<template>
  <article class="bubble" :class="[message.role, { error: message.isError }]">
    <div v-if="message.role === 'assistant'" class="content markdown-content">
      <div v-if="message.isError" class="error-heading">运行失败</div>
      <MarkdownRenderer :content="message.content || '…'" />
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
