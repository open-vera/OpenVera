<script setup lang="ts">
import { ref } from "vue";
import type { ChatAttachment } from "@/types";
import {
  attachmentLabel,
  createChatAttachments,
} from "@/utils/attachments";

const emit = defineEmits<{
  submit: [payload: { text: string; attachments: ChatAttachment[] }];
  abort: [];
}>();

defineProps<{
  disabled?: boolean;
  running?: boolean;
}>();

const text = ref("");
const attachments = ref<ChatAttachment[]>([]);
const fileInput = ref<HTMLInputElement | null>(null);
const isReadingFiles = ref(false);
const attachmentError = ref("");
const isComposing = ref(false);

async function addFiles(files: Iterable<File>) {
  const selected = Array.from(files);
  if (!selected.length) return;
  attachmentError.value = "";
  isReadingFiles.value = true;
  try {
    attachments.value.push(...await createChatAttachments(selected));
  } catch (error) {
    attachmentError.value =
      error instanceof Error ? error.message : "读取附件失败，请重试。";
  } finally {
    isReadingFiles.value = false;
  }
}

function openFilePicker() {
  fileInput.value?.click();
}

function onFileChange(event: Event) {
  const input = event.target as HTMLInputElement;
  void addFiles(input.files ?? []);
  input.value = "";
}

function onPaste(event: ClipboardEvent) {
  const files = Array.from(event.clipboardData?.items ?? [])
    .filter((item) => item.kind === "file")
    .map((item) => item.getAsFile())
    .filter((file): file is File => Boolean(file));
  if (!files.length) return;
  event.preventDefault();
  void addFiles(files);
}

function removeAttachment(id: string) {
  attachments.value = attachments.value.filter((item) => item.id !== id);
}

function onSubmit() {
  const value = text.value.trim();
  if (!value && !attachments.value.length) return;
  emit("submit", {
    text: value,
    attachments: attachments.value,
  });
  text.value = "";
  attachments.value = [];
}

function onAbort() {
  emit("abort");
}

function onEnter(event: KeyboardEvent) {
  if (event.isComposing || isComposing.value) return;
  event.preventDefault();
  onSubmit();
}
</script>

<template>
  <footer class="composer">
    <form class="composer-card" @submit.prevent="onSubmit">
      <div v-if="attachments.length" class="attachments" aria-label="已添加附件">
        <span
          v-for="attachment in attachments"
          :key="attachment.id"
          class="attachment-chip"
          :title="attachmentLabel(attachment)"
        >
          <span class="attachment-kind">{{ attachment.kind === "image" ? "IMG" : "FILE" }}</span>
          <span class="attachment-name">{{ attachment.name }}</span>
          <button
            type="button"
            class="attachment-remove"
            :disabled="disabled"
            :aria-label="`移除 ${attachment.name}`"
            @click="removeAttachment(attachment.id)"
          >
            ×
          </button>
        </span>
      </div>
      <p v-if="attachmentError" class="attachment-error">{{ attachmentError }}</p>
      <textarea
        v-model="text"
        :disabled="disabled"
        placeholder="告诉 Partner 要做什么"
        rows="3"
        @compositionstart="isComposing = true"
        @compositionend="isComposing = false"
        @keydown.enter.exact="onEnter"
        @paste="onPaste"
      />
      <div class="composer-toolbar">
        <div class="composer-left">
          <button type="button" class="pill" disabled>
            <span class="pill-icon">∞</span>
            Agent
          </button>
          <button type="button" class="model" disabled>Claude</button>
        </div>
        <div class="composer-actions">
          <input
            ref="fileInput"
            type="file"
            class="file-input"
            multiple
            @change="onFileChange"
          />
          <button
            type="button"
            class="icon-button"
            title="附件"
            :disabled="disabled || isReadingFiles"
            @click="openFilePicker"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M8.5 13.5 15.7 6.3a3 3 0 0 1 4.2 4.2L10 20.4a5 5 0 0 1-7.1-7.1l9.2-9.2" />
            </svg>
          </button>
          <button
            :type="running ? 'button' : 'submit'"
            class="send-button"
            :disabled="disabled || isReadingFiles || (!running && !text.trim() && !attachments.length)"
            :title="running ? '停止当前任务' : '发送'"
            @click="running ? onAbort() : undefined"
          >
            <svg v-if="running" viewBox="0 0 24 24" aria-hidden="true">
              <rect x="7" y="7" width="10" height="10" rx="2" />
            </svg>
            <svg v-else viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 5v14M6.5 10.5 12 5l5.5 5.5" />
            </svg>
          </button>
        </div>
      </div>
    </form>
  </footer>
</template>

<style scoped>
.composer {
  padding: 10px 12px 12px;
  background: linear-gradient(
    to bottom,
    color-mix(in srgb, var(--bg) 86%, transparent),
    var(--bg)
  );
}

.composer-card {
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: min(920px, 100%);
  margin: 0 auto;
  padding: 14px 14px 10px;
  border: 1px solid var(--border);
  border-radius: 18px;
  background: var(--surface-elevated);
  box-shadow:
    0 10px 32px color-mix(in srgb, #000 18%, transparent),
    inset 0 1px 0 color-mix(in srgb, #fff 6%, transparent);
  transition:
    border-color 120ms ease,
    box-shadow 120ms ease;
}

.composer-card:focus-within {
  border-color: color-mix(in srgb, var(--text-muted) 52%, var(--border));
  box-shadow:
    0 0 0 1px color-mix(in srgb, var(--text-muted) 18%, transparent),
    0 10px 32px color-mix(in srgb, #000 18%, transparent);
}

.composer-card textarea {
  width: 100%;
  min-height: 72px;
  max-height: 180px;
  resize: none;
  padding: 0;
  border: none;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 15px;
  line-height: 1.45;
}

.composer-card textarea:focus {
  outline: none;
}

.composer-card textarea::placeholder {
  color: var(--text-muted);
}

.attachments {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.attachment-chip {
  display: inline-flex;
  align-items: center;
  max-width: min(280px, 100%);
  height: 28px;
  border: 1px solid color-mix(in srgb, var(--border) 80%, transparent);
  border-radius: 999px;
  background: color-mix(in srgb, var(--surface) 82%, transparent);
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
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.attachment-remove {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 24px;
  height: 24px;
  margin-left: 2px;
  border: none;
  border-radius: 999px;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
}

.attachment-remove:hover {
  color: var(--text);
  background: var(--surface-hover);
}

.attachment-error {
  margin: -2px 0 0;
  color: var(--danger, #ff6b6b);
  font-size: 12px;
}

.composer-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.composer-left,
.composer-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.pill,
.model {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 0 10px;
  background: var(--surface);
  color: var(--text-muted);
  font-size: 13px;
}

.pill-icon {
  font-size: 16px;
  line-height: 1;
}

.file-input {
  display: none;
}

.icon-button,
.send-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 32px;
  height: 32px;
  border: none;
  border-radius: 999px;
  padding: 0;
}

.icon-button {
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
}

.send-button {
  background: var(--accent);
  color: var(--accent-text);
  cursor: pointer;
}

.icon-button svg,
.send-button svg {
  width: 18px;
  height: 18px;
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.send-button svg rect {
  fill: currentColor;
  stroke: none;
}

.icon-button:disabled,
.pill:disabled,
.model:disabled,
.attachment-remove:disabled {
  cursor: default;
}

.icon-button:disabled {
  opacity: 0.45;
}

.send-button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
