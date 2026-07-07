<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useModelCatalogStore } from "@/stores/model-catalog";
import { useSettingsStore } from "@/stores/settings";
import { useWorkspaceStore } from "@/stores/workspace";
import type { AgentRunMode, CatalogModel, CatalogProvider, ChatAttachment, LLMProtocol } from "@/types";
import {
  attachmentLabel,
  createChatAttachments,
} from "@/utils/attachments";
import { modelDisplayLabel, providerDisplayLabel } from "@/utils/model-presets";
import { LLM_PROTOCOL_OPTIONS, protocolLabel } from "@/utils/llm-protocol";

const emit = defineEmits<{
  submit: [payload: { text: string; attachments: ChatAttachment[] }];
  abort: [];
}>();

defineProps<{
  disabled?: boolean;
  running?: boolean;
}>();

const settings = useSettingsStore();
const workspace = useWorkspaceStore();
const modelCatalog = useModelCatalogStore();

const text = ref("");
const attachments = ref<ChatAttachment[]>([]);
const textareaRef = ref<HTMLTextAreaElement | null>(null);
const fileInput = ref<HTMLInputElement | null>(null);
const isReadingFiles = ref(false);
const attachmentError = ref("");
const isComposing = ref(false);
const lastCompositionEndAt = ref(0);
const modeMenuOpen = ref(false);
const modelMenuOpen = ref(false);
const modeButtonRef = ref<HTMLButtonElement | null>(null);
const modelButtonRef = ref<HTMLButtonElement | null>(null);
const modeMenuStyle = ref<Record<string, string>>({});
const modelMenuStyle = ref<Record<string, string>>({});
const isSavingModel = ref(false);
const expandedProviderId = ref<string | null>(null);

const modeOptions: Array<{
  value: AgentRunMode;
  icon: string;
  label: string;
  hint: string;
}> = [
  { value: "agent", icon: "∞", label: "Agent", hint: "自动分流，可使用工具" },
  { value: "chat", icon: "💬", label: "Chat", hint: "纯对话，不使用工具" },
  { value: "plan", icon: "📋", label: "Plan", hint: "规划模式，适合复杂任务" },
];

const protocolOptions = LLM_PROTOCOL_OPTIONS;

const activeMode = computed(() =>
  modeOptions.find((option) => option.value === settings.agentMode) ?? modeOptions[0],
);

const modelLabel = computed(() => {
  const models = modelCatalog.modelsForProvider(settings.provider.id);
  const current = models.find(
    (model) =>
      model.id === settings.provider.model ||
      model.upstreamId === settings.provider.model,
  );
  return modelDisplayLabel(settings.provider.id, settings.provider.model, current);
});

const activeProtocolLabel = computed(() => protocolLabel(settings.provider.protocol));

const providerRows = computed(() => modelCatalog.availableProviders);

function positionMenu(
  button: HTMLButtonElement | null,
  menuHeight: number,
): Record<string, string> {
  if (!button) return {};
  const rect = button.getBoundingClientRect();
  const width = 260;
  const left = Math.min(Math.max(12, rect.left), window.innerWidth - width - 12);
  const top = Math.max(12, rect.top - menuHeight - 8);
  return {
    position: "fixed",
    left: `${left}px`,
    top: `${top}px`,
    width: `${width}px`,
    zIndex: "40",
  };
}

function openModeMenu() {
  modelMenuOpen.value = false;
  modeMenuOpen.value = !modeMenuOpen.value;
  if (modeMenuOpen.value) {
    modeMenuStyle.value = positionMenu(modeButtonRef.value, 168);
  }
}

function openModelMenu() {
  modeMenuOpen.value = false;
  modelMenuOpen.value = !modelMenuOpen.value;
  if (modelMenuOpen.value) {
    modelMenuStyle.value = positionMenu(modelButtonRef.value, 360);
    void modelCatalog.loadProviders(workspace.rootPath || undefined);
    const currentProvider = settings.provider.id;
    expandedProviderId.value = currentProvider;
    void modelCatalog.ensureProviderModels(workspace.rootPath || undefined, currentProvider);
  }
}

function closeMenus() {
  modeMenuOpen.value = false;
  modelMenuOpen.value = false;
  expandedProviderId.value = null;
}

async function toggleProvider(provider: CatalogProvider) {
  if (expandedProviderId.value === provider.id) {
    expandedProviderId.value = null;
    return;
  }
  expandedProviderId.value = provider.id;
  await modelCatalog.ensureProviderModels(workspace.rootPath || undefined, provider.id);
}

function isModelSelected(providerId: string, model: CatalogModel): boolean {
  if (settings.provider.id !== providerId) return false;
  if (settings.provider.model === model.id) return true;
  return Boolean(model.upstreamId && settings.provider.model === model.upstreamId);
}

async function selectMode(mode: AgentRunMode) {
  settings.setAgentMode(mode);
  await settings.save(workspace.rootPath || undefined);
  closeMenus();
}

async function selectProtocol(protocol: LLMProtocol) {
  if (settings.provider.protocol === protocol) return;
  settings.setProtocol(protocol);
  await settings.save(workspace.rootPath || undefined);
  modelCatalog.invalidateProvider(settings.provider.id);
  if (modelMenuOpen.value) {
    expandedProviderId.value = settings.provider.id;
    await modelCatalog.ensureProviderModels(
      workspace.rootPath || undefined,
      settings.provider.id,
      { protocol },
    );
  }
}

async function selectModel(provider: CatalogProvider, model: CatalogModel) {
  if (isModelSelected(provider.id, model)) {
    closeMenus();
    return;
  }
  isSavingModel.value = true;
  try {
    settings.applyProviderModel({
      providerId: provider.id,
      protocol: provider.protocol as LLMProtocol,
      apiBaseUrl: provider.apiBaseUrl,
      model: model.id,
    });
    await settings.save(workspace.rootPath || undefined);
  } finally {
    isSavingModel.value = false;
    closeMenus();
  }
}

function onDocumentPointerDown(event: PointerEvent) {
  const target = event.target;
  if (!(target instanceof Element) || !target.closest("[data-input-bar-menu]")) {
    closeMenus();
  }
}

interface InputDebugEntry {
  type: string;
  timestamp: string;
  key?: string;
  code?: string;
  keyCode?: number;
  isComposing?: boolean;
  composingState: boolean;
  textLength: number;
  note?: string;
}

function appendInputDebug(entry: InputDebugEntry) {
  const target = window as typeof window & { __partnerInputDebug?: InputDebugEntry[] };
  const next = [...(target.__partnerInputDebug ?? []), entry].slice(-80);
  target.__partnerInputDebug = next;
  window.localStorage.setItem("partner:input-debug", JSON.stringify(next));
  console.debug("[PartnerInput]", entry);
}

function debugInputEvent(type: string, event?: KeyboardEvent | CompositionEvent, note?: string) {
  appendInputDebug({
    type,
    timestamp: new Date().toISOString(),
    key: event instanceof KeyboardEvent ? event.key : undefined,
    code: event instanceof KeyboardEvent ? event.code : undefined,
    keyCode: event instanceof KeyboardEvent ? event.keyCode : undefined,
    isComposing: event instanceof KeyboardEvent ? event.isComposing : undefined,
    composingState: isComposing.value,
    textLength: text.value.length,
    note,
  });
}

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
  debugInputEvent("submit", undefined, "emit submit");
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

function focus() {
  textareaRef.value?.focus();
}

defineExpose({ focus });

function onCompositionStart(event: CompositionEvent) {
  isComposing.value = true;
  debugInputEvent("compositionstart", event);
}

function onCompositionEnd(event: CompositionEvent) {
  lastCompositionEndAt.value = Date.now();
  isComposing.value = false;
  debugInputEvent("compositionend", event);
}

function onEnter(event: KeyboardEvent) {
  const justEndedComposition = Date.now() - lastCompositionEndAt.value < 80;
  const composingByKeyCode = event.keyCode === 229;
  debugInputEvent("keydown.enter", event, JSON.stringify({
    justEndedComposition,
    composingByKeyCode,
  }));
  if (event.isComposing || isComposing.value || justEndedComposition || composingByKeyCode) {
    return;
  }
  event.preventDefault();
  onSubmit();
}

onMounted(() => {
  document.addEventListener("pointerdown", onDocumentPointerDown);
});

onBeforeUnmount(() => {
  document.removeEventListener("pointerdown", onDocumentPointerDown);
});
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
        ref="textareaRef"
        v-model="text"
        :disabled="disabled"
        placeholder="告诉 Partner 要做什么"
        rows="3"
        @compositionstart="onCompositionStart"
        @compositionend="onCompositionEnd"
        @keydown.enter.exact="onEnter"
        @paste="onPaste"
      />
      <div class="composer-toolbar">
        <div class="composer-left" data-input-bar-menu>
          <button
            ref="modeButtonRef"
            type="button"
            class="pill menu-trigger"
            :class="{ active: modeMenuOpen }"
            :disabled="disabled"
            :title="activeMode.hint"
            @click="openModeMenu"
          >
            <span class="pill-icon">{{ activeMode.icon }}</span>
            {{ activeMode.label }}
          </button>
          <button
            ref="modelButtonRef"
            type="button"
            class="model menu-trigger"
            :class="{ active: modelMenuOpen }"
            :disabled="disabled || isSavingModel"
            :title="`${providerDisplayLabel(settings.provider.id)} · ${settings.provider.model} · ${activeProtocolLabel}`"
            @click="openModelMenu"
          >
            {{ modelLabel }}
          </button>

          <div
            v-if="modeMenuOpen"
            class="input-menu"
            :style="modeMenuStyle"
            data-input-bar-menu
          >
            <p class="menu-title">运行模式</p>
            <button
              v-for="option in modeOptions"
              :key="option.value"
              type="button"
              class="menu-item"
              :class="{ selected: settings.agentMode === option.value }"
              @click="selectMode(option.value)"
            >
              <span class="menu-item-icon">{{ option.icon }}</span>
              <span class="menu-item-body">
                <strong>{{ option.label }}</strong>
                <small>{{ option.hint }}</small>
              </span>
            </button>
          </div>

          <div
            v-if="modelMenuOpen"
            class="input-menu model-menu"
            :style="modelMenuStyle"
            data-input-bar-menu
          >
            <p class="menu-title">模型</p>
            <div class="protocol-section">
              <p class="menu-subtitle">协议</p>
              <div class="protocol-options">
                <button
                  v-for="option in protocolOptions"
                  :key="option.value"
                  type="button"
                  class="protocol-option"
                  :class="{ selected: settings.provider.protocol === option.value }"
                  :disabled="isSavingModel"
                  @click="selectProtocol(option.value)"
                >
                  {{ option.label }}
                </button>
              </div>
            </div>
            <p v-if="modelCatalog.loadingProviders && !providerRows.length" class="menu-status">
              加载供应商…
            </p>
            <p v-else-if="modelCatalog.providersError" class="menu-error">
              {{ modelCatalog.providersError }}
            </p>
            <p v-else-if="!providerRows.length" class="menu-status">未找到已配置 API Key 的供应商</p>
            <section
              v-for="provider in providerRows"
              :key="provider.id"
              class="provider-section"
            >
              <button
                type="button"
                class="provider-toggle"
                :class="{ expanded: expandedProviderId === provider.id }"
                :aria-expanded="expandedProviderId === provider.id"
                @click="toggleProvider(provider)"
              >
                <span
                  class="provider-chevron"
                  :class="{ expanded: expandedProviderId === provider.id }"
                  aria-hidden="true"
                >
                  <svg viewBox="0 0 20 20">
                    <path d="M5 8l5 5 5-5" />
                  </svg>
                </span>
                <span class="provider-toggle-label">
                  <strong>{{ providerDisplayLabel(provider.id) }}</strong>
                  <small v-if="provider.isDefault">默认</small>
                </span>
                <span
                  v-if="modelCatalog.isProviderLoading(provider.id)"
                  class="provider-loading"
                >
                  加载中…
                </span>
              </button>

              <div
                v-if="expandedProviderId === provider.id"
                class="provider-models"
              >
                <p
                  v-if="modelCatalog.providerErrors[provider.id]"
                  class="menu-error compact"
                >
                  {{ modelCatalog.providerErrors[provider.id] }}
                </p>
                <button
                  v-for="model in modelCatalog.modelsForProvider(provider.id)"
                  :key="`${provider.id}:${model.id}`"
                  type="button"
                  class="menu-item compact"
                  :class="{ selected: isModelSelected(provider.id, model) }"
                  @click="selectModel(provider, model)"
                >
                  <span class="menu-item-body">
                    <strong>{{ model.displayName || model.id }}</strong>
                    <small v-if="model.upstreamId">{{ model.upstreamId }}</small>
                  </span>
                </button>
                <p
                  v-if="
                    modelCatalog.isProviderRefreshing(provider.id) &&
                    !modelCatalog.modelsForProvider(provider.id).length
                  "
                  class="menu-status compact"
                >
                  正在同步远程模型…
                </p>
                <p
                  v-else-if="
                    !modelCatalog.isProviderLoading(provider.id) &&
                    !modelCatalog.providerErrors[provider.id] &&
                    !modelCatalog.modelsForProvider(provider.id).length
                  "
                  class="menu-status compact"
                >
                  暂无可用模型
                </p>
              </div>
            </section>
          </div>
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

.composer-left {
  position: relative;
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

.menu-trigger {
  cursor: pointer;
  transition:
    border-color 120ms ease,
    color 120ms ease,
    background 120ms ease;
}

.menu-trigger:hover:not(:disabled),
.menu-trigger.active {
  color: var(--text);
  border-color: color-mix(in srgb, var(--accent) 42%, var(--border));
  background: color-mix(in srgb, var(--accent) 8%, var(--surface));
}

.input-menu {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface-elevated);
  box-shadow: 0 12px 32px color-mix(in srgb, #000 24%, transparent);
}

.model-menu {
  max-height: min(420px, 56vh);
  overflow: auto;
}

.menu-title {
  margin: 0 4px 2px;
  color: var(--text-muted);
  font-size: 11px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.protocol-section {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0 0 6px;
  padding: 0 4px 8px;
  border-bottom: 1px solid color-mix(in srgb, var(--border) 72%, transparent);
}

.menu-subtitle {
  margin: 0;
  color: var(--text-muted);
  font-size: 11px;
}

.protocol-options {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.protocol-option {
  min-height: 26px;
  border: 1px solid color-mix(in srgb, var(--border) 88%, transparent);
  border-radius: 999px;
  padding: 0 10px;
  background: var(--bg);
  color: var(--text-muted);
  font: inherit;
  font-size: 11px;
  cursor: pointer;
}

.protocol-option:hover:not(:disabled) {
  color: var(--text);
  border-color: color-mix(in srgb, var(--accent) 42%, var(--border));
}

.protocol-option.selected {
  color: var(--accent);
  border-color: color-mix(in srgb, var(--accent) 55%, var(--border));
  background: color-mix(in srgb, var(--accent) 10%, var(--bg));
}

.protocol-option:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.menu-status,
.menu-error {
  margin: 0 4px;
  font-size: 12px;
}

.menu-status {
  color: var(--text-muted);
}

.menu-error {
  color: var(--danger, #ff6b6b);
}

.menu-status.compact,
.menu-error.compact {
  padding: 4px 8px 0;
}

.provider-section + .provider-section {
  margin-top: 4px;
  padding-top: 4px;
  border-top: 1px solid color-mix(in srgb, var(--border) 72%, transparent);
}

.provider-toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 8px;
  border: 1px solid transparent;
  border-radius: 8px;
  background: transparent;
  color: var(--text);
  text-align: left;
  cursor: pointer;
}

.provider-toggle:hover,
.provider-toggle.expanded {
  background: var(--surface-hover);
}

.provider-chevron {
  width: 18px;
  height: 18px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  color: var(--text-muted);
}

.provider-chevron svg {
  width: 14px;
  height: 14px;
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
  transform: rotate(-90deg);
  transition: transform 120ms ease;
}

.provider-chevron.expanded svg {
  transform: rotate(0deg);
}

.provider-toggle-label {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  flex: 1;
}

.provider-toggle-label strong {
  font-size: 13px;
}

.provider-toggle-label small {
  color: var(--accent);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.provider-loading {
  flex-shrink: 0;
  color: var(--text-muted);
  font-size: 12px;
}

.provider-models {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 2px 0 4px 10px;
}

.menu-item {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  width: 100%;
  padding: 8px;
  border: 1px solid transparent;
  border-radius: 8px;
  background: transparent;
  color: var(--text);
  text-align: left;
  cursor: pointer;
}

.menu-item.compact {
  padding: 7px 8px;
}

.menu-item:hover {
  background: var(--surface-hover);
}

.menu-item.selected {
  border-color: color-mix(in srgb, var(--accent) 36%, transparent);
  background: color-mix(in srgb, var(--accent) 10%, transparent);
}

.menu-item-icon {
  flex-shrink: 0;
  width: 18px;
  font-size: 14px;
  line-height: 1.4;
}

.menu-item-body {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.menu-item-body strong {
  font-size: 13px;
  font-weight: 600;
}

.menu-item-body small {
  color: var(--text-muted);
  font-size: 11px;
  line-height: 1.35;
  overflow-wrap: anywhere;
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
.menu-trigger:disabled,
.attachment-remove:disabled {
  cursor: default;
  opacity: 0.45;
}

.send-button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
