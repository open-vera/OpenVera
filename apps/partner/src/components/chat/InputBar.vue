<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import ChevronIcon from "@/components/ui/ChevronIcon.vue";
import { useModelCatalogStore } from "@/stores/model-catalog";
import { usePreviewStore } from "@/stores/preview";
import { useSettingsStore } from "@/stores/settings";
import { useWorkspaceStore } from "@/stores/workspace";
import type {
  AgentRunMode,
  CatalogModel,
  CatalogProvider,
  ChatAttachment,
  TokenUsage,
} from "@/types";
import ContextUsageRing from "./ContextUsageRing.vue";
import {
  attachmentChipKind,
  attachmentDisplayName,
  attachmentLabel,
  createChatAttachments,
  createChatAttachmentsFromDragItems,
  createChatAttachmentsFromPaths,
  createSelectionAttachment,
  mergeChatAttachments,
} from "@/utils/attachments";
import {
  setComposerDropHoverHandler,
  setComposerPathDropHandler,
} from "@/utils/composer-drop";
import { modelDisplayLabel, providerDisplayLabel } from "@/utils/model-presets";
import { protocolLabel, resolveCatalogProtocol } from "@/utils/llm-protocol";
import { alertDialog } from "@/utils/native-dialog";
import {
  PARTNER_PATHS_MIME,
  clearActivePartnerDrag,
  readPartnerPathsDrag,
  readPartnerSelectionClipboard,
} from "@/utils/partner-dnd";
import {
  positionAnchoredMenu,
  type AnchoredMenuPosition,
} from "@/utils/position-anchored-menu";

const emit = defineEmits<{
  submit: [payload: { text: string; attachments: ChatAttachment[] }];
  abort: [];
}>();

defineProps<{
  disabled?: boolean;
  running?: boolean;
  usage?: TokenUsage | null;
}>();

const settings = useSettingsStore();
const workspace = useWorkspaceStore();
const modelCatalog = useModelCatalogStore();
const preview = usePreviewStore();

const text = ref("");
const attachments = ref<ChatAttachment[]>([]);
const textareaRef = ref<HTMLTextAreaElement | null>(null);
const fileInput = ref<HTMLInputElement | null>(null);
const isReadingFiles = ref(false);
const attachmentError = ref("");
const dropActive = ref(false);
let dragDepth = 0;
const isComposing = ref(false);
const lastCompositionEndAt = ref(0);
const modeMenuOpen = ref(false);
const modelMenuOpen = ref(false);
const modeButtonRef = ref<HTMLButtonElement | null>(null);
const modelButtonRef = ref<HTMLButtonElement | null>(null);
const modeMenuStyle = ref<AnchoredMenuPosition | Record<string, never>>({});
const modelMenuStyle = ref<AnchoredMenuPosition | Record<string, never>>({});
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
  preferredMaxHeight: number,
): AnchoredMenuPosition | Record<string, never> {
  return positionAnchoredMenu(button?.getBoundingClientRect() ?? null, window, {
    preferredMaxHeight,
    width: 260,
    preferAbove: true,
    zIndex: 200,
  });
}

function openModeMenu() {
  modelMenuOpen.value = false;
  modeMenuOpen.value = !modeMenuOpen.value;
  if (modeMenuOpen.value) {
    modeMenuStyle.value = positionMenu(modeButtonRef.value, 220);
  }
}

function openModelMenu() {
  modeMenuOpen.value = false;
  modelMenuOpen.value = !modelMenuOpen.value;
  if (modelMenuOpen.value) {
    modelMenuStyle.value = positionMenu(modelButtonRef.value, 420);
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

async function selectModel(provider: CatalogProvider, model: CatalogModel) {
  if (isModelSelected(provider.id, model)) {
    closeMenus();
    return;
  }
  isSavingModel.value = true;
  try {
    settings.applyProviderModel({
      providerId: provider.id,
      protocol: resolveCatalogProtocol(provider),
      apiBaseUrl: provider.apiBaseUrl || settings.provider.apiBaseUrl,
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

function appendAttachments(incoming: ChatAttachment[]) {
  if (!incoming.length) return;
  attachments.value = mergeChatAttachments(attachments.value, incoming);
}

async function addFiles(files: Iterable<File>) {
  const selected = Array.from(files);
  if (!selected.length) return;
  attachmentError.value = "";
  isReadingFiles.value = true;
  try {
    appendAttachments(await createChatAttachments(selected));
  } catch (error) {
    attachmentError.value =
      error instanceof Error ? error.message : "读取附件失败，请重试。";
  } finally {
    isReadingFiles.value = false;
  }
}

async function addPaths(paths: string[]) {
  if (!paths.length) return;
  attachmentError.value = "";
  isReadingFiles.value = true;
  try {
    appendAttachments(await createChatAttachmentsFromPaths(paths));
  } catch (error) {
    attachmentError.value =
      error instanceof Error ? error.message : "添加路径失败，请重试。";
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
  const selection = readPartnerSelectionClipboard(event.clipboardData);
  if (selection) {
    event.preventDefault();
    appendAttachments([createSelectionAttachment(selection)]);
    return;
  }

  const files = Array.from(event.clipboardData?.items ?? [])
    .filter((item) => item.kind === "file")
    .map((item) => item.getAsFile())
    .filter((file): file is File => Boolean(file));
  if (!files.length) return;
  event.preventDefault();
  void addFiles(files);
}

function hasPartnerDrag(event: DragEvent): boolean {
  const types = Array.from(event.dataTransfer?.types ?? []);
  return (
    types.includes(PARTNER_PATHS_MIME) ||
    types.includes("Files") ||
    types.includes("text/uri-list")
  );
}

function onDragEnter(event: DragEvent) {
  if (!hasPartnerDrag(event)) return;
  event.preventDefault();
  dragDepth += 1;
  dropActive.value = true;
}

function onDragOver(event: DragEvent) {
  if (!hasPartnerDrag(event)) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
  dropActive.value = true;
}

function onDragLeave(event: DragEvent) {
  if (!hasPartnerDrag(event)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) dropActive.value = false;
}

function onDrop(event: DragEvent) {
  event.preventDefault();
  dragDepth = 0;
  dropActive.value = false;

  const partnerItems = readPartnerPathsDrag(event.dataTransfer);
  if (partnerItems.length) {
    clearActivePartnerDrag();
    appendAttachments(createChatAttachmentsFromDragItems(partnerItems));
    return;
  }

  const files = Array.from(event.dataTransfer?.files ?? []);
  if (files.length) {
    clearActivePartnerDrag();
    void addFiles(files);
  }
}

function removeAttachment(id: string) {
  attachments.value = attachments.value.filter((item) => item.id !== id);
}

async function previewAttachment(attachment: ChatAttachment) {
  if (attachment.kind === "image" && attachment.dataUrl) {
    preview.openImagePreview({
      id: attachment.id,
      name: attachment.name,
      dataUrl: attachment.dataUrl,
    });
    return;
  }
  if (attachment.kind === "selection" && attachment.content) {
    const range =
      attachment.startLine && attachment.endLine
        ? ` L${attachment.startLine}-${attachment.endLine}`
        : "";
    await alertDialog(
      `${attachment.path ?? attachment.name}${range}\n\n${attachment.content.slice(0, 2000)}`,
    );
    return;
  }
  if (attachment.path) {
    await alertDialog(attachment.path);
    return;
  }
  await alertDialog(
    attachment.kind === "image"
      ? `「${attachment.name}」过大，未生成可预览的缩略图。`
      : `「${attachment.name}」暂不支持预览。`,
  );
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
  setComposerPathDropHandler((paths) => {
    void addPaths(paths);
  });
  setComposerDropHoverHandler((active) => {
    dropActive.value = active;
  });
});

onBeforeUnmount(() => {
  document.removeEventListener("pointerdown", onDocumentPointerDown);
  setComposerPathDropHandler(null);
  setComposerDropHoverHandler(null);
  dropActive.value = false;
});
</script>

<template>
  <footer class="composer">
    <form
      class="composer-card"
      data-composer-drop
      :class="{ 'drop-active': dropActive }"
      @submit.prevent="onSubmit"
      @dragenter="onDragEnter"
      @dragover="onDragOver"
      @dragleave="onDragLeave"
      @drop="onDrop"
    >
      <div v-if="attachments.length" class="attachments" aria-label="已添加附件">
        <div
          v-for="attachment in attachments"
          :key="attachment.id"
          class="attachment-chip"
          :class="{
            image: attachment.kind === 'image' && attachment.dataUrl,
            clickable:
              (attachment.kind === 'image' && Boolean(attachment.dataUrl)) ||
              attachment.kind === 'selection' ||
              Boolean(attachment.path),
            reference:
              attachment.kind === 'path' ||
              attachment.kind === 'folder' ||
              attachment.kind === 'selection',
          }"
        >
          <button
            type="button"
            class="attachment-preview"
            :title="attachmentLabel(attachment, settings.locale)"
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
          <button
            type="button"
            class="attachment-remove"
            :disabled="disabled"
            :aria-label="`移除 ${attachmentDisplayName(attachment)}`"
            @click="removeAttachment(attachment.id)"
          >
            ×
          </button>
        </div>
      </div>
      <p v-if="attachmentError" class="attachment-error">{{ attachmentError }}</p>
      <textarea
        ref="textareaRef"
        v-model="text"
        :disabled="disabled"
        placeholder="一起创造点什么"
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
            <span class="model-label">{{ modelLabel }}</span>
          </button>
          <ContextUsageRing mode="context" :usage="usage" />

          <Teleport to="body">
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
                  <span class="provider-chevron" aria-hidden="true">
                    <ChevronIcon :expanded="expandedProviderId === provider.id" />
                  </span>
                  <span class="provider-toggle-label">
                    <strong>{{ providerDisplayLabel(provider.id) }}</strong>
                    <small v-if="provider.isDefault">已启用</small>
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
          </Teleport>
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
  /* Horizontal inset comes from ChatPanel --chat-side-pad so messages align. */
  padding: 10px 0 12px;
  background: transparent;
}

.composer-card {
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: 100%;
  max-width: var(--chat-column-max, 920px);
  margin: 0 auto;
  padding: 14px 14px 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: color-mix(in srgb, var(--surface-elevated) 78%, transparent);
  box-shadow: none;
  transition:
    border-color 120ms ease,
    box-shadow 120ms ease;
}

.composer-card:focus-within {
  border-color: color-mix(in srgb, var(--accent) 70%, var(--border));
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent) 36%, transparent);
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

.composer-card.drop-active {
  outline: 1px solid color-mix(in srgb, var(--accent) 55%, transparent);
  border-color: color-mix(in srgb, var(--accent) 70%, var(--border));
  background: color-mix(
    in srgb,
    var(--accent) 8%,
    var(--surface-elevated-solid, var(--surface-elevated))
  );
}

.attachment-chip {
  display: inline-flex;
  align-items: center;
  max-width: min(280px, 100%);
  min-height: 28px;
  border: 1px solid color-mix(in srgb, var(--border) 80%, transparent);
  border-radius: 10px;
  background: color-mix(in srgb, var(--surface) 82%, transparent);
  color: var(--text);
  font-size: 12px;
  overflow: hidden;
}

.attachment-chip.reference {
  border-color: color-mix(in srgb, var(--accent) 40%, var(--border));
  background: color-mix(
    in srgb,
    var(--accent) 12%,
    var(--surface-elevated-solid, var(--surface-elevated))
  );
}

.attachment-chip.image {
  position: relative;
  min-height: 0;
  padding: 0;
  border-radius: 12px;
}

.attachment-preview {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  margin: 0;
  padding: 0 0 0 2px;
  border: none;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: default;
}

.attachment-chip.image .attachment-preview {
  padding: 0;
}

.attachment-chip.clickable .attachment-preview {
  cursor: zoom-in;
}

.attachment-chip.clickable .attachment-preview:hover .attachment-name {
  color: var(--accent);
}

.attachment-chip.image.clickable .attachment-preview:hover .attachment-thumb {
  filter: brightness(1.08);
}

.attachment-thumb {
  width: 44px;
  height: 44px;
  flex-shrink: 0;
  object-fit: cover;
  border-radius: 7px;
  background: color-mix(in srgb, var(--surface-elevated) 80%, transparent);
}

.attachment-chip.image .attachment-thumb {
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
  max-width: 160px;
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

.attachment-chip.image .attachment-remove {
  position: absolute;
  top: 4px;
  right: 4px;
  width: 22px;
  height: 22px;
  margin: 0;
  background: color-mix(in srgb, var(--surface-elevated) 88%, transparent);
  color: var(--text);
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.28);
}

.attachment-remove:hover {
  color: var(--text);
  background: var(--surface-hover);
}

.attachment-error {
  margin: -2px 0 0;
  color: var(--danger);
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

.model {
  max-width: min(200px, 36vw);
  min-width: 0;
}

.model-label {
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
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
  background: var(--surface-elevated-solid, var(--surface-elevated));
  -webkit-backdrop-filter: none;
  backdrop-filter: none;
  box-shadow: 0 12px 32px color-mix(in srgb, #000 24%, transparent);
  overflow: auto;
  overscroll-behavior: contain;
}

.menu-title {
  margin: 0 4px 2px;
  color: var(--text-muted);
  font-size: 11px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
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
  color: var(--danger);
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
  font-size: 14px;
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
