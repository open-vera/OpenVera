<script setup lang="ts">
import { computed, ref } from "vue";
import type { ChatAttachment, Message } from "@/types";
import { usePreviewStore } from "@/stores/preview";
import { useSettingsStore } from "@/stores/settings";
import {
  attachmentChipKind,
  attachmentDisplayName,
  attachmentLabel,
} from "@/utils/attachments";
import { copyTextToClipboard } from "@/utils/clipboard";
import MarkdownRenderer from "./MarkdownRenderer.vue";

const props = defineProps<{
  message: Message;
}>();

defineEmits<{
  promoteQueued: [messageId: string];
  runQueuedNow: [messageId: string];
}>();

const settings = useSettingsStore();
const preview = usePreviewStore();
const copyState = ref<"idle" | "copied" | "failed">("idle");
let copyResetTimer: ReturnType<typeof setTimeout> | null = null;

function previewAttachment(attachment: ChatAttachment) {
  if (attachment.kind === "image" && attachment.dataUrl) {
    preview.openImagePreview({
      id: attachment.id,
      name: attachment.name,
      dataUrl: attachment.dataUrl,
    });
  }
}

const queueLabel = computed(() =>
  settings.locale === "en"
    ? { next: "next", queued: "queued", promote: "prioritize", runNow: "run now" }
    : { next: "下一条", queued: "排队中", promote: "优先", runNow: "现在执行" },
);

const copyButtonLabel = computed(() => {
  if (copyState.value === "copied") {
    return settings.locale === "en" ? "Copied" : "已复制";
  }
  if (copyState.value === "failed") {
    return settings.locale === "en" ? "Failed" : "失败";
  }
  return settings.locale === "en" ? "Copy" : "复制";
});

const canCopyAssistantMessage = computed(
  () => props.message.role === "assistant" && props.message.content.trim().length > 0,
);

async function copyAssistantMessage(): Promise<void> {
  if (!canCopyAssistantMessage.value) return;
  if (copyResetTimer) {
    clearTimeout(copyResetTimer);
    copyResetTimer = null;
  }
  try {
    await copyTextToClipboard(props.message.content);
    copyState.value = "copied";
  } catch (error) {
    copyState.value = "failed";
    console.warn("[MessageBubble] failed to copy assistant message:", error);
  }
  copyResetTimer = setTimeout(() => {
    copyState.value = "idle";
    copyResetTimer = null;
  }, 1200);
}
</script>

<template>
  <article
    class="bubble"
    :class="[message.role, { error: message.isError, queued: message.queueStatus === 'queued' }]"
  >
    <div
      v-if="message.role === 'assistant'"
      class="content markdown-content message-shell"
      :class="{ 'has-copy': canCopyAssistantMessage }"
    >
      <button
        v-if="canCopyAssistantMessage"
        type="button"
        class="message-copy-button"
        :aria-label="copyButtonLabel"
        @click="copyAssistantMessage"
      >
        {{ copyButtonLabel }}
      </button>
      <div v-if="message.isError" class="error-heading">运行失败</div>
      <pre
        v-if="message.isError"
        class="error-body"
      >{{ message.content || "…" }}</pre>
      <MarkdownRenderer
        v-else
        :content="message.content || '…'"
      />
    </div>
    <div v-else class="content">
      {{ message.content || "…" }}
      <span v-if="message.queueStatus" class="queue-controls">
        <span class="queue-badge">
          {{ message.queueStatus === "next" ? queueLabel.next : queueLabel.queued }}
        </span>
        <button
          v-if="message.queueStatus === 'queued'"
          type="button"
          class="queue-action"
          @click.stop="$emit('promoteQueued', message.id)"
        >
          {{ queueLabel.promote }}
        </button>
        <button
          type="button"
          class="queue-action"
          @click.stop="$emit('runQueuedNow', message.id)"
        >
          {{ queueLabel.runNow }}
        </button>
      </span>
      <div v-if="message.attachments?.length" class="message-attachments">
        <button
          v-for="attachment in message.attachments"
          :key="attachment.id"
          type="button"
          class="message-attachment"
          :class="{
            image: attachment.kind === 'image' && attachment.dataUrl,
            clickable: attachment.kind === 'image' && attachment.dataUrl,
            reference:
              attachment.kind === 'path' ||
              attachment.kind === 'folder' ||
              attachment.kind === 'selection',
          }"
          :title="attachmentLabel(attachment, settings.locale)"
          :disabled="!(attachment.kind === 'image' && attachment.dataUrl)"
          @click="previewAttachment(attachment)"
        >
          <img
            v-if="attachment.kind === 'image' && attachment.dataUrl"
            class="attachment-thumb"
            :src="attachment.dataUrl"
            :alt="attachmentLabel(attachment, settings.locale)"
          />
          <template v-else>
            <span class="attachment-kind">
              {{ attachmentChipKind(attachment) }}
            </span>
            <span class="attachment-name">{{ attachmentDisplayName(attachment) }}</span>
          </template>
        </button>
      </div>
    </div>
  </article>
</template>

<style scoped>
.bubble {
  max-width: min(86%, 860px);
  padding: 10px 13px;
  border-radius: 6px;
  font-size: 14px;
  line-height: 1.5;
}

.bubble.user {
  align-self: flex-end;
  background: var(--surface-elevated);
  border: 1px solid var(--border);
  color: var(--text);
}

.queue-controls {
  display: inline-flex;
  align-items: center;
  margin-left: 8px;
  gap: 6px;
  vertical-align: baseline;
}

.queue-badge {
  display: inline-flex;
  align-items: center;
  padding: 0;
  border-radius: 999px;
  background: transparent;
  color: color-mix(in srgb, var(--text-muted) 72%, transparent);
  font-size: 12px;
  font-weight: 400;
  line-height: 1;
}

.queue-badge::before {
  content: "·";
  margin-right: 6px;
  color: color-mix(in srgb, var(--text-muted) 45%, transparent);
}

.queue-action {
  border: none;
  border-radius: 4px;
  padding: 1px 4px;
  background: transparent;
  color: color-mix(in srgb, var(--text-muted) 76%, transparent);
  font: inherit;
  font-size: 11px;
  line-height: 1.3;
  cursor: pointer;
}

.queue-action:hover {
  background: color-mix(in srgb, var(--surface) 72%, transparent);
  color: var(--text);
}

.bubble.assistant {
  align-self: flex-start;
  width: var(--chat-assistant-width, min(92%, 900px));
  max-width: var(--chat-assistant-width, min(92%, 900px));
  padding: 0;
  background: transparent;
  border: none;
}

.bubble.assistant.error {
  padding: 12px 14px;
  border: 1px solid color-mix(in srgb, var(--danger) 58%, var(--border));
  border-radius: 14px;
  background: color-mix(in srgb, var(--danger) 10%, var(--surface-elevated));
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

.message-shell {
  position: relative;
}

.message-shell.has-copy {
  padding-top: 2px;
  padding-right: 2px;
}

.message-copy-button {
  position: absolute;
  top: 4px;
  right: 4px;
  z-index: 2;
  height: 24px;
  border: 1px solid color-mix(in srgb, var(--border) 72%, transparent);
  border-radius: 6px;
  padding: 0 8px;
  background: color-mix(in srgb, var(--surface) 88%, transparent);
  color: var(--text-muted);
  font: inherit;
  font-size: 11px;
  line-height: 22px;
  cursor: pointer;
  opacity: 0;
  transition:
    opacity 120ms ease,
    background 120ms ease,
    color 120ms ease;
}

.message-shell:hover .message-copy-button,
.message-copy-button:focus-visible {
  opacity: 1;
}

.message-copy-button:hover {
  background: var(--surface-hover);
  color: var(--text);
}

.bubble.assistant.error .message-copy-button {
  background: color-mix(in srgb, var(--surface-elevated) 90%, transparent);
}

.markdown-content :deep(hr) {
  display: none;
}

.error-heading {
  margin-bottom: 8px;
  color: var(--danger-muted);
  font-weight: 700;
}

.error-body {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--text);
  font: inherit;
  font-size: 13px;
  line-height: 1.55;
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
  gap: 8px;
  max-width: 280px;
  min-height: 26px;
  margin: 0;
  padding: 0;
  border: 1px solid color-mix(in srgb, var(--border) 80%, transparent);
  border-radius: 10px;
  background: color-mix(in srgb, var(--surface) 72%, transparent);
  color: var(--text);
  font: inherit;
  font-size: 12px;
  overflow: hidden;
  cursor: default;
  text-align: left;
}

.message-attachment.reference {
  border-color: color-mix(in srgb, var(--accent) 40%, var(--border));
  background: color-mix(
    in srgb,
    var(--accent) 12%,
    var(--surface-elevated-solid, var(--surface-elevated))
  );
}

.message-attachment.image {
  min-height: 0;
  padding: 0;
  border-radius: 12px;
}

.message-attachment.clickable {
  cursor: zoom-in;
}

.message-attachment.clickable:hover .attachment-name {
  color: var(--accent);
}

.message-attachment.image.clickable:hover .attachment-thumb {
  filter: brightness(1.08);
}

.message-attachment:disabled {
  cursor: default;
  opacity: 1;
}

.attachment-thumb {
  width: 44px;
  height: 44px;
  flex-shrink: 0;
  object-fit: cover;
  border-radius: 7px;
}

.message-attachment.image .attachment-thumb {
  width: 72px;
  height: 72px;
  border-radius: 11px;
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
