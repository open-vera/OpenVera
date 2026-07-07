<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { inspectLlmConfig, readFile } from "@/bridge";
import { usePreviewStore } from "@/stores/preview";
import { useSettingsStore } from "@/stores/settings";
import { useWorkspaceStore } from "@/stores/workspace";
import type { AppLocale, EffectiveLlmConfig, LLMProviderId, LLMProtocol } from "@/types";

const settings = useSettingsStore();
const workspace = useWorkspaceStore();
const preview = usePreviewStore();
const apiKey = ref("");
const status = ref("");
const error = ref("");
const effectiveConfig = ref<EffectiveLlmConfig | null>(null);
const isInspecting = ref(false);
const inspectError = ref("");
const revealEffectiveKey = ref(false);
const isReady = ref(false);
const isSavingConfig = ref(false);
let saveTimer: number | undefined;

const INSPECT_TIMEOUT_MS = 5_000;

const baseProviderOptions: Array<{ value: LLMProviderId; label: string }> = [
  { value: "anthropic", label: "Anthropic" },
  { value: "openai", label: "OpenAI" },
  { value: "gemini", label: "Gemini" },
];
const providerOptions = computed(() => {
  if (baseProviderOptions.some((option) => option.value === settings.provider.id)) {
    return baseProviderOptions;
  }
  return [
    ...baseProviderOptions,
    { value: settings.provider.id, label: settings.provider.id },
  ];
});

const protocolOptions: Array<{ value: LLMProtocol; label: string }> = [
  { value: "anthropic", label: "Anthropic" },
  { value: "openai-compatible", label: "OpenAI Compatible" },
  { value: "gemini", label: "Gemini" },
];

const localeOptions: Array<{ value: AppLocale; label: string }> = [
  { value: "zh", label: "中文" },
  { value: "en", label: "English" },
];

const copy = computed(() => {
  if (settings.locale === "en") {
    return {
      title: "Model Settings",
      description:
        "Configure the model service used by Agent. Settings are written to Vera settings.json.",
      language: "Language",
      languageHint: "Switch the Partner interface language",
      providerHint: "Choose the model provider",
      protocol: "Protocol",
      protocolHint: "Match the request format of the service",
      apiBaseHint: "Official or compatible service endpoint",
      model: "Model",
      modelHint: "Model ID sent to the provider",
      keySaved: "Stored in Vera settings.json",
      keyMissing: "No key saved yet",
      keyReplacePlaceholder: "Enter a new value, saved on blur",
      keyPlaceholder: "Enter API Key",
      clear: "Clear",
      saving: "Saving...",
      saved: "Auto-saved",
      keySavedStatus: "Key saved to Vera settings.json",
      keyCleared: "Key cleared",
      effectiveTitle: "Effective Runtime Config",
      effectiveHint:
        "This is what Partner will actually use from Vera config and environment variables.",
      refresh: "Refresh",
      loadingEffective: "Reading effective config...",
      inspectTimeout:
        "Reading timed out. If the app was already running, restart Partner so the new sidecar command is loaded.",
      source: "Source",
      keyState: "API Key",
      keyAvailable: "Available",
      keyUnavailable: "Missing",
      showKey: "Show",
      hideKey: "Hide",
      configPath: "Config Path",
      editJson: "Edit JSON",
      projectRoot: "Project Root",
      adapter: "Adapter",
      notAvailable: "N/A",
    };
  }
  return {
    title: "大模型设置",
    description: "配置 Agent 使用的模型服务。配置会写入 Vera settings.json。",
    language: "语言",
    languageHint: "切换 Partner 界面显示语言",
    providerHint: "选择模型供应商",
    protocol: "协议",
    protocolHint: "适配不同服务的请求格式",
    apiBaseHint: "支持官方或兼容服务地址",
    model: "模型",
    modelHint: "发送给供应商的模型 ID",
    keySaved: "已保存到 Vera settings.json",
    keyMissing: "尚未保存密钥",
    keyReplacePlaceholder: "输入新值，失焦后覆盖",
    keyPlaceholder: "输入 API Key",
    clear: "清除",
    saving: "正在保存…",
    saved: "已自动保存",
    keySavedStatus: "密钥已自动保存到 Vera settings.json",
    keyCleared: "密钥已清除",
    effectiveTitle: "实际运行配置",
    effectiveHint:
      "这里展示 Partner 真正会读取的 Vera 配置和环境变量。",
    refresh: "刷新",
    loadingEffective: "正在读取实际配置…",
    inspectTimeout: "读取超时。如果应用已在运行，请重启 Partner，让新的 sidecar 命令生效。",
    source: "来源",
    keyState: "API Key",
    keyAvailable: "可用",
    keyUnavailable: "缺失",
    showKey: "显示",
    hideKey: "隐藏",
    configPath: "配置路径",
    editJson: "编辑 JSON",
    projectRoot: "项目根目录",
    adapter: "适配器",
    notAvailable: "无",
  };
});

function clearStatus() {
  status.value = "";
  error.value = "";
}

async function ensureLoaded() {
  if (!settings.isLoaded) {
    await settings.load(workspace.rootPath || undefined);
  }
}

function scheduleConfigSave() {
  if (!isReady.value || isSavingConfig.value) return;
  clearStatus();
  status.value = copy.value.saving;
  if (saveTimer) {
    window.clearTimeout(saveTimer);
  }
  saveTimer = window.setTimeout(() => {
    void saveConfig();
  }, 350);
}

async function saveConfig() {
  clearStatus();
  isSavingConfig.value = true;
  try {
    await settings.save(workspace.rootPath || undefined);
    await refreshEffectiveConfig();
    status.value = copy.value.saved;
  } catch (saveError) {
    error.value = saveError instanceof Error ? saveError.message : String(saveError);
  } finally {
    isSavingConfig.value = false;
  }
}

async function refreshEffectiveConfig() {
  isInspecting.value = true;
  inspectError.value = "";
  try {
    effectiveConfig.value = await withTimeout(
      inspectLlmConfig(
        workspace.rootPath || undefined,
        null,
        revealEffectiveKey.value,
      ),
      INSPECT_TIMEOUT_MS,
      copy.value.inspectTimeout,
    );
  } catch (configError) {
    effectiveConfig.value = null;
    inspectError.value = configError instanceof Error ? configError.message : String(configError);
  } finally {
    isInspecting.value = false;
  }
}

async function toggleEffectiveKey() {
  revealEffectiveKey.value = !revealEffectiveKey.value;
  if (!revealEffectiveKey.value && effectiveConfig.value) {
    effectiveConfig.value = {
      ...effectiveConfig.value,
      apiKeyValue: undefined,
    };
    return;
  }
  await refreshEffectiveConfig();
}

async function openConfigJson() {
  const path = effectiveConfig.value?.configPath;
  if (!path) return;
  try {
    const content = await readFile(path);
    preview.openCodeFile(path, content);
  } catch (openError) {
    inspectError.value = openError instanceof Error ? openError.message : String(openError);
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      reject(new Error(message));
    }, timeoutMs);
    promise.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (reason: unknown) => {
        window.clearTimeout(timer);
        reject(reason);
      },
    );
  });
}

async function saveApiKeyIfNeeded() {
  clearStatus();
  const nextKey = apiKey.value.trim();
  if (!nextKey) return;
  try {
    await settings.saveApiKey(nextKey, workspace.rootPath || undefined);
    apiKey.value = "";
    await refreshEffectiveConfig();
    status.value = copy.value.keySavedStatus;
  } catch (saveError) {
    error.value = saveError instanceof Error ? saveError.message : String(saveError);
  }
}

async function deleteApiKey() {
  clearStatus();
  try {
    await settings.saveApiKey("", workspace.rootPath || undefined);
    apiKey.value = "";
    await refreshEffectiveConfig();
    status.value = copy.value.keyCleared;
  } catch (deleteError) {
    error.value = deleteError instanceof Error ? deleteError.message : String(deleteError);
  }
}

async function onProviderChange(event: Event) {
  const target = event.target as HTMLSelectElement;
  settings.setProviderId(target.value as LLMProviderId);
}

function onProtocolChange(event: Event) {
  const target = event.target as HTMLSelectElement;
  settings.setProtocol(target.value as LLMProtocol);
}

function onLocaleChange(event: Event) {
  const target = event.target as HTMLSelectElement;
  settings.setLocale(target.value as AppLocale);
}

onMounted(() => {
  void (async () => {
    await ensureLoaded();
    await refreshEffectiveConfig();
    isReady.value = true;
  })();
});

onBeforeUnmount(() => {
  if (saveTimer) {
    window.clearTimeout(saveTimer);
  }
});

watch(
  () => [
    settings.provider.id,
    settings.provider.protocol,
    settings.provider.apiBaseUrl,
    settings.provider.model,
    settings.locale,
  ],
  scheduleConfigSave,
);
</script>

<template>
  <section class="settings-panel">
    <div class="settings-header">
      <h2>{{ copy.title }}</h2>
      <p>{{ copy.description }}</p>
    </div>

    <div class="settings-card">
      <label class="setting-row">
        <span class="setting-label">
          <strong>{{ copy.language }}</strong>
          <small>{{ copy.languageHint }}</small>
        </span>
        <select :value="settings.locale" @change="onLocaleChange">
          <option
            v-for="option in localeOptions"
            :key="option.value"
            :value="option.value"
          >
            {{ option.label }}
          </option>
        </select>
      </label>

      <label class="setting-row">
        <span class="setting-label">
          <strong>Provider</strong>
          <small>{{ copy.providerHint }}</small>
        </span>
        <select :value="settings.provider.id" @change="onProviderChange">
          <option
            v-for="option in providerOptions"
            :key="option.value"
            :value="option.value"
          >
            {{ option.label }}
          </option>
        </select>
      </label>

      <label class="setting-row">
        <span class="setting-label">
          <strong>{{ copy.protocol }}</strong>
          <small>{{ copy.protocolHint }}</small>
        </span>
        <select :value="settings.provider.protocol" @change="onProtocolChange">
          <option
            v-for="option in protocolOptions"
            :key="option.value"
            :value="option.value"
          >
            {{ option.label }}
          </option>
        </select>
      </label>

      <label class="setting-row">
        <span class="setting-label">
          <strong>API Base URL</strong>
          <small>{{ copy.apiBaseHint }}</small>
        </span>
        <input
          v-model.trim="settings.provider.apiBaseUrl"
          type="url"
          placeholder="https://api.example.com/v1"
        />
      </label>

      <label class="setting-row">
        <span class="setting-label">
          <strong>{{ copy.model }}</strong>
          <small>{{ copy.modelHint }}</small>
        </span>
        <input
          v-model.trim="settings.provider.model"
          type="text"
          placeholder="claude-sonnet-4-20250514"
        />
      </label>

      <label class="setting-row">
        <span class="setting-label">
          <strong>API Key</strong>
          <small>
            {{ settings.hasApiKey ? copy.keySaved : copy.keyMissing }}
          </small>
        </span>
        <span class="key-control">
          <input
            v-model="apiKey"
            type="password"
            autocomplete="new-password"
            :placeholder="settings.hasApiKey ? copy.keyReplacePlaceholder : copy.keyPlaceholder"
            @blur="saveApiKeyIfNeeded"
            @keydown.enter.prevent="saveApiKeyIfNeeded"
          />
          <button
            v-if="settings.hasApiKey"
            type="button"
            class="link-button"
            @click="deleteApiKey"
          >
            {{ copy.clear }}
          </button>
        </span>
      </label>
    </div>

    <p v-if="status" class="status">{{ status }}</p>
    <p v-if="error" class="status error">{{ error }}</p>

    <section class="effective-card">
      <div class="effective-header">
        <span>
          <strong>{{ copy.effectiveTitle }}</strong>
          <small>{{ copy.effectiveHint }}</small>
        </span>
        <button type="button" class="link-button" @click="refreshEffectiveConfig">
          {{ copy.refresh }}
        </button>
      </div>
      <p v-if="isInspecting" class="status">{{ copy.loadingEffective }}</p>
      <p v-else-if="inspectError" class="status error">{{ inspectError }}</p>
      <dl v-else-if="effectiveConfig" class="effective-grid">
        <div>
          <dt>{{ copy.source }}</dt>
          <dd>{{ effectiveConfig.sourceLabel }}</dd>
        </div>
        <div>
          <dt>Provider</dt>
          <dd>{{ effectiveConfig.provider }}</dd>
        </div>
        <div>
          <dt>{{ copy.adapter }}</dt>
          <dd>{{ effectiveConfig.adapter }}</dd>
        </div>
        <div>
          <dt>{{ copy.model }}</dt>
          <dd>{{ effectiveConfig.model }}</dd>
        </div>
        <div>
          <dt>API Base URL</dt>
          <dd>{{ effectiveConfig.apiBaseUrl || copy.notAvailable }}</dd>
        </div>
        <div>
          <dt>{{ copy.keyState }}</dt>
          <dd>{{ effectiveConfig.apiKeyAvailable ? copy.keyAvailable : copy.keyUnavailable }}</dd>
        </div>
        <div v-if="effectiveConfig.apiKeyAvailable">
          <dt>API Key Value</dt>
          <dd class="key-source">
            <span>{{ revealEffectiveKey ? effectiveConfig.apiKeyValue : "••••••••" }}</span>
            <button
              type="button"
              class="inline-link-button"
              @click="toggleEffectiveKey"
            >
              {{ revealEffectiveKey ? copy.hideKey : copy.showKey }}
            </button>
          </dd>
        </div>
        <div>
          <dt>{{ copy.configPath }}</dt>
          <dd class="key-source">
            <span>{{ effectiveConfig.configPath || copy.notAvailable }}</span>
            <button
              v-if="effectiveConfig.configPath"
              type="button"
              class="inline-link-button"
              @click="openConfigJson"
            >
              {{ copy.editJson }}
            </button>
          </dd>
        </div>
        <div>
          <dt>{{ copy.projectRoot }}</dt>
          <dd>{{ effectiveConfig.projectRoot }}</dd>
        </div>
      </dl>
    </section>
  </section>
</template>

<style scoped>
.settings-panel {
  height: 100%;
  overflow: auto;
  padding: 18px;
  color: var(--text);
  container-type: inline-size;
}

.settings-header {
  width: min(100%, 780px);
  margin-bottom: 16px;
}

.settings-header h2 {
  margin: 0 0 6px;
  font-size: 18px;
  font-weight: 650;
}

.settings-header p {
  margin: 0;
  color: var(--text-muted);
  font-size: 12px;
}

.settings-card {
  width: min(100%, 780px);
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface-elevated);
}

.effective-card {
  width: min(100%, 780px);
  margin-top: 18px;
  padding: 14px 16px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface-elevated);
}

.effective-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 12px;
}

.effective-header span {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.effective-header strong {
  font-size: 13px;
  font-weight: 650;
}

.effective-header small {
  color: var(--text-muted);
  font-size: 11px;
  line-height: 1.45;
}

.effective-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px 18px;
  margin: 0;
}

.effective-grid div {
  min-width: 0;
}

.effective-grid dt {
  margin-bottom: 3px;
  color: var(--text-muted);
  font-size: 11px;
}

.effective-grid dd {
  margin: 0;
  overflow: hidden;
  color: var(--text);
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.key-source {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.key-source span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.inline-link-button {
  flex-shrink: 0;
  border: none;
  border-radius: 4px;
  padding: 0 4px;
  background: color-mix(in srgb, var(--accent) 10%, transparent);
  color: var(--accent);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}

.setting-row {
  display: grid;
  grid-template-columns: minmax(170px, 0.8fr) minmax(260px, 1.2fr);
  align-items: center;
  gap: 18px;
  min-height: 64px;
  padding: 12px 16px;
  border-bottom: 1px solid color-mix(in srgb, var(--border) 72%, transparent);
}

.setting-row:last-child {
  border-bottom: none;
}

.setting-label {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

.setting-label strong {
  font-size: 13px;
  font-weight: 650;
}

.setting-label small {
  color: var(--text-muted);
  font-size: 11px;
}

input,
select {
  width: 100%;
  min-height: 30px;
  border: 1px solid var(--border);
  border-radius: 3px;
  padding: 0 9px;
  background: var(--bg);
  color: var(--text);
  font: inherit;
  font-size: 12px;
}

input:focus,
select:focus {
  border-color: color-mix(in srgb, var(--accent) 70%, var(--border));
  outline: 1px solid color-mix(in srgb, var(--accent) 36%, transparent);
}

.key-control {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.key-control input {
  min-width: 0;
}

.link-button {
  flex-shrink: 0;
  border: none;
  padding: 0;
  background: transparent;
  color: var(--text-muted);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}

.link-button:hover {
  color: var(--accent);
}

.status {
  max-width: 680px;
  margin: 8px 0 0;
  color: var(--accent);
  font-size: 12px;
}

.status.error {
  color: #f28b82;
}

@container (max-width: 560px) {
  .settings-row,
  .setting-row {
    grid-template-columns: 1fr;
    align-items: stretch;
    gap: 8px;
  }

  .effective-header {
    flex-direction: column;
    gap: 8px;
  }

  .effective-grid {
    grid-template-columns: 1fr;
  }
}
</style>
