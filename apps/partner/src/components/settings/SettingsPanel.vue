<script setup lang="ts">
import { homeDir, join } from "@tauri-apps/api/path";
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
} from "vue";
import { inspectLlmConfig, readFile } from "@/bridge";
import {
  listLlmProviderModels,
  refreshLlmProviderModels,
  testLlmConnection,
} from "@/bridge/llm-catalog";
import PartnerCombobox from "@/components/ui/PartnerCombobox.vue";
import PartnerSelect, {
  type PartnerSelectGroup,
  type PartnerSelectOption,
} from "@/components/ui/PartnerSelect.vue";
import { useModelCatalogStore } from "@/stores/model-catalog";
import { usePreviewStore } from "@/stores/preview";
import { useSettingsStore } from "@/stores/settings";
import { useWorkspaceStore } from "@/stores/workspace";
import {
  BUILTIN_WALLPAPER_ORDER,
  BUILTIN_WALLPAPERS,
  isBuiltinWallpaperId,
  MAX_WALLPAPER_BLUR,
  MAX_WALLPAPER_OPACITY,
  MIN_WALLPAPER_BLUR,
  MIN_WALLPAPER_OPACITY,
  THEME_OPTIONS,
  type AppThemeId,
  type CustomPaletteId,
  type WallpaperMode,
} from "@/theme";
import type {
  AppLocale,
  CatalogModel,
  CatalogProvider,
  LLMProtocol,
} from "@/types";
import { LLM_PROTOCOL_OPTIONS } from "@/utils/llm-protocol";
import {
  isScrolledToBottom,
  pickActiveSection,
  type SectionOffset,
} from "@/utils/section-nav";
import StorageUsageSection from "./StorageUsageSection.vue";
import EditorSettingsSection from "./EditorSettingsSection.vue";

const settings = useSettingsStore();
const workspace = useWorkspaceStore();
const preview = usePreviewStore();
const modelCatalog = useModelCatalogStore();
const apiKey = ref("");
const apiKeyFocused = ref(false);
const revealApiKey = ref(false);
const loadedApiKey = ref<string | null>(null);
const status = ref("");
const error = ref("");
const connectionTestFeedback = ref<{
  type: "success" | "error";
  message: string;
} | null>(null);
/** Effective Vera settings.json path (project wins over global when present). */
const settingsJsonPath = ref("");
const globalSettingsJsonPath = ref("");
const configScope = ref<"explicit" | "env" | "project" | "global" | "">("");
const editJsonHintOpen = ref(false);
let editJsonHintTimer: number | undefined;

/** Only when project `.vera/settings.json` is the active file do we show the dual-config tip. */
const showProjectConfigHint = computed(() => configScope.value === "project");

const API_KEY_MASK = "••••••••••••••••";

const apiKeyDisplay = computed(() => {
  if (apiKey.value) return apiKey.value;
  if (revealApiKey.value && loadedApiKey.value) return loadedApiKey.value;
  if (settings.hasApiKey && !apiKeyFocused.value) return API_KEY_MASK;
  return "";
});
const isReady = ref(false);
const isSavingConfig = ref(false);
/** Skip autosave while swapping the edited provider chip. */
const isSwitchingProvider = ref(false);
const isTestingConnection = ref(false);
const showModelList = ref(false);
const isLoadingModels = ref(false);
const modelList = ref<CatalogModel[]>([]);
const modelListError = ref("");
const wallpaperInput = ref<HTMLInputElement | null>(null);
const wallpaperBusy = ref(false);
/** Local slider value; blur filter is applied after debounce. */
const wallpaperBlurDraft = ref(settings.wallpaperBlur);
const providerIdDraft = ref(settings.provider.id);
let saveTimer: number | undefined;
let modelsRoutingTimer: number | undefined;
let blurApplyTimer: number | undefined;

const modelAliasOptions = computed(() =>
  settings.modelAliases.map((item) => ({
    value: item.alias,
    label:
      item.model && item.model !== item.alias
        ? `${item.alias} → ${item.model}`
        : item.alias,
  }))
);

const providerSelectOptions = computed(() =>
  providerProfiles.value.map((item) => ({
    value: item.id,
    label: item.id,
  }))
);

function upstreamModelOptions(providerId: string): PartnerSelectOption[] {
  return modelCatalog.modelsForProvider(providerId).map((model) => {
    const value = model.upstreamId || model.id;
    const label =
      model.displayName && model.displayName !== model.id
        ? `${value} · ${model.displayName}`
        : value;
    return { value, label };
  });
}

function ensureProviderModelOptions(providerId: string) {
  if (!providerId) return;
  void modelCatalog.ensureProviderModels(
    workspace.rootPath || undefined,
    providerId
  );
}

function ensureAliasProviderModels() {
  const ids = new Set<string>([
    settings.provider.id,
    ...settings.modelAliases.map((item) => item.provider).filter(Boolean),
  ]);
  for (const id of ids) {
    ensureProviderModelOptions(id);
  }
}

const INSPECT_TIMEOUT_MS = 5_000;
const REMOTE_MODEL_TIMEOUT_MS = 35_000;
const WALLPAPER_BLUR_DEBOUNCE_MS = 120;

const protocolOptions = LLM_PROTOCOL_OPTIONS;
const providerProfiles = computed(() => modelCatalog.providers);
const editingIsDefault = computed(
  () =>
    providerProfiles.value.find((item) => item.id === settings.provider.id)
      ?.isDefault ?? false
);

const localeOptions: Array<{ value: AppLocale; label: string }> = [
  { value: "zh", label: "中文" },
  { value: "en", label: "English" },
];

const themeOptions = THEME_OPTIONS;
const builtinWallpapers = BUILTIN_WALLPAPER_ORDER.map(
  (id) => BUILTIN_WALLPAPERS[id]
);

const wallpaperPreviewUrl = computed(() => {
  if (settings.wallpaperMode === "custom" && settings.wallpaperDataUrl) {
    return settings.wallpaperDataUrl;
  }
  if (isBuiltinWallpaperId(settings.wallpaperMode)) {
    return BUILTIN_WALLPAPERS[settings.wallpaperMode].previewUrl ?? null;
  }
  return null;
});

/** Tuning + custom scales only when a concrete wallpaper is chosen (not follow-theme / none). */
const showWallpaperTuning = computed(
  () =>
    settings.wallpaperMode === "custom" ||
    isBuiltinWallpaperId(settings.wallpaperMode)
);
const showCustomPalettes = showWallpaperTuning;

function wallpaperBuiltinLabel(id: (typeof BUILTIN_WALLPAPER_ORDER)[number]) {
  const wallpaper = BUILTIN_WALLPAPERS[id];
  return settings.locale === "en" ? wallpaper.labelEn : wallpaper.labelZh;
}

const localeSelectOptions = computed<PartnerSelectOption[]>(() =>
  localeOptions.map((option) => ({ value: option.value, label: option.label }))
);

const themeSelectOptions = computed<PartnerSelectOption[]>(() =>
  themeOptions.map((option) => ({
    value: option.id,
    label: settings.locale === "en" ? option.labelEn : option.labelZh,
    preview: option.preview,
  }))
);

const themeSelectValue = computed(() =>
  settings.theme === "custom" ? "" : settings.theme
);

const themeTriggerOption = computed<PartnerSelectOption | null>(() => {
  if (settings.theme === "custom" && settings.activeCustomPalette) {
    const palette = settings.activeCustomPalette;
    return {
      value: "custom",
      label:
        settings.locale === "en"
          ? `${copy.value.themeCustom} · ${palette.labelEn}`
          : `${copy.value.themeCustom} · ${palette.labelZh}`,
      preview: palette.preview,
    };
  }
  return (
    themeSelectOptions.value.find(
      (option) => option.value === settings.theme
    ) ?? null
  );
});

const wallpaperSelectGroups = computed<PartnerSelectGroup[]>(() => [
  {
    label: "",
    options: [
      { value: "theme", label: copy.value.wallpaperTheme },
      { value: "none", label: copy.value.wallpaperNone },
    ],
  },
  {
    label: copy.value.wallpaperBuiltinGroup,
    options: builtinWallpapers.map((wallpaper) => ({
      value: wallpaper.id,
      label: wallpaperBuiltinLabel(wallpaper.id),
    })),
  },
  {
    label: "",
    options: [{ value: "custom", label: copy.value.wallpaperCustom }],
  },
]);

const protocolSelectOptions = computed<PartnerSelectOption[]>(() =>
  protocolOptions.map((option) => ({
    value: option.value,
    label: option.label,
  }))
);

const customPaletteSelectOptions = computed<PartnerSelectOption[]>(() =>
  settings.customPalettes.map((palette) => ({
    value: palette.id,
    label: settings.locale === "en" ? palette.labelEn : palette.labelZh,
    preview: palette.preview,
  }))
);

const customPaletteSelectValue = computed(() =>
  settings.theme === "custom" && settings.customPaletteId
    ? settings.customPaletteId
    : ""
);

const copy = computed(() => {
  if (settings.locale === "en") {
    return {
      title: "Settings",
      description:
        "Appearance stays in Partner. LLM profiles are stored in Vera settings.json.",
      appearanceTitle: "Appearance",
      appearanceHint: "Language, theme, and wallpaper for this Partner window.",
      llmTitle: "LLM Providers",
      llmHint:
        "Providers hold connection settings. Models and routing below map to Vera settings.json (models / default_model / routing).",
      language: "Language",
      languageHint: "Switch the Partner interface language",
      theme: "Theme",
      themeHint: "Preset colors. Picking a custom scale below clears this.",
      themeCustom: "Custom",
      wallpaper: "Background",
      wallpaperHint:
        "Follow theme uses the theme defaults. Pick a builtin/custom image to tune clarity and blur.",
      wallpaperTheme: "Follow theme",
      wallpaperNone: "None",
      wallpaperBuiltinGroup: "Builtin",
      wallpaperCustom: "Custom image",
      wallpaperUpload: "Choose image",
      wallpaperClear: "Clear image",
      wallpaperOpacity: "Clarity",
      wallpaperBlur: "Blur",
      wallpaperUploading: "Processing image...",
      wallpaperReady: "Background image updated",
      customPalettes: "Custom",
      customPalettesHint:
        "Scales from the background. Airy/Soft use light mode with denser frosted panels; Deep/Vivid stay dark. Selecting clears the theme above",
      customPalettesLoading: "Extracting colors...",
      customPalettesEmpty: "Choose a background image to extract custom scales",
      customPalettesPlaceholder: "Choose a custom scale",
      providersLabel: "Profiles",
      providersHint:
        "Click any provider to edit it. Runtime still uses the default until you enable another.",
      newProvider: "New",
      newProviderPrompt: "Provider id (e.g. gateway, deepseek, work-claude):",
      defaultBadge: "Default",
      setDefault: "Enable",
      alreadyDefault: "Enabled",
      editingDefault: "Editing the enabled runtime provider",
      editingOther:
        "Browsing this profile — click “Enable” to use it at runtime",
      protocol: "Protocol",
      protocolHint: "Match the request format of the service",
      apiBaseHint: "Official or compatible service endpoint",
      providerId: "Provider id",
      providerIdHint:
        "Key in settings.json providers; rename updates all references",
      model: "Model",
      modelHint: "Upstream model id for an alias",
      modelsRoutingTitle: "Models & routing",
      modelsRoutingHint:
        "Aliases in models{}, plus default_model and intent routing (classifier / L0 / L1 / L2).",
      modelAlias: "Alias",
      modelProvider: "Provider",
      modelUpstream: "Upstream model",
      modelPickEmpty: "No models yet — type an id, or open View Models to sync",
      aliasPickEmpty: "No aliases yet — type a name",
      addModel: "Add alias",
      removeModel: "Remove",
      defaultModel: "Default model",
      defaultModelHint: "Used when routing is off (or as chat default)",
      routingEnabled: "Intent routing",
      routingEnabledHint: "Pick models by task complexity (Vera L0–L2)",
      routingClassifier: "Classifier",
      routingL0: "L0 (simple)",
      routingL1: "L1 (default)",
      routingL2: "L2 (complex)",
      addAsAlias: "Add as alias",
      keySaved:
        "Saved — masked below; click Show to reveal (default only), or type a new key",
      keyMissing: "No key saved yet",
      keyReplacePlaceholder: "Type a new key to replace",
      keyPlaceholder: "Enter API Key",
      showKey: "Show",
      hideKey: "Hide",
      saving: "Saving...",
      saved: "Auto-saved",
      keySavedStatus: "Key saved to Vera settings.json",
      refresh: "Refresh",
      inspectTimeout:
        "Reading timed out. If the app was already running, restart Partner so the new sidecar command is loaded.",
      editJson: "Edit JSON",
      editJsonProjectHint:
        "Project config is active (.vera/settings.json). Click to edit it.",
      editJsonGlobal: "Edit global config",
      configPathMissing: "No settings.json path available.",
      testConnection: "Test Connection",
      viewModels: "View Models",
      testingConnection: "Testing connection...",
      testSuccess: (count: number) =>
        count > 0
          ? `Connection OK. ${count} model(s) available.`
          : "Connection OK, but no models were returned.",
      testFailed: "Connection failed",
      testTimeout: "Connection test timed out. Check network or API base URL.",
      modelListTitle: "Available Models",
      modelListHint:
        "Configured models load instantly; remote models sync from the provider API.",
      loadingModels: "Loading model list...",
      modelListTimeout:
        "Remote model sync timed out. Showing configured models only.",
      modelListEmpty: "No models found for this provider.",
      modelSourceConfig: "config",
      modelSourceRemote: "remote",
      hideModels: "Hide",
      emptyProviders:
        "No providers in settings.json yet. Create one to get started.",
      emptyModels:
        "No model aliases yet. Add one or pick from the remote list.",
    };
  }
  return {
    title: "设置",
    description: "外观保存在 Partner 本地；大模型配置写入 Vera settings.json。",
    appearanceTitle: "外观",
    appearanceHint: "语言、主题与壁纸，仅影响当前 Partner 窗口。",
    llmTitle: "大模型",
    llmHint:
      "Provider 负责连接；下方「模型与路由」对应 settings.json 的 models / default_model / routing。",
    language: "语言",
    languageHint: "切换 Partner 界面显示语言",
    theme: "主题",
    themeHint: "预设配色；若选用下方自定义色阶，此处会取消勾选",
    themeCustom: "自定义",
    wallpaper: "背景图",
    wallpaperHint:
      "跟随主题时使用主题默认效果；选择内置/自定义背景后可调通透度与模糊",
    wallpaperTheme: "跟随主题",
    wallpaperNone: "无",
    wallpaperBuiltinGroup: "内置背景",
    wallpaperCustom: "自定义图片",
    wallpaperUpload: "选择图片",
    wallpaperClear: "清除图片",
    wallpaperOpacity: "通透度",
    wallpaperBlur: "模糊",
    wallpaperUploading: "正在处理图片…",
    wallpaperReady: "背景图已更新",
    customPalettes: "自定义",
    customPalettesHint:
      "根据背景提取色阶。清透/柔和为浅色（面板会更实、自动轻度磨砂），深邃/浓郁为深色。点选后上方主题会取消勾选",
    customPalettesLoading: "正在提取配色…",
    customPalettesEmpty: "选择背景图后可提取自定义色阶",
    customPalettesPlaceholder: "选择自定义色阶",
    providersLabel: "Provider 配置",
    providersHint:
      "可随意点选查看/编辑；运行时仍用当前默认，需手动点「启用」才会切换。",
    newProvider: "新建",
    newProviderPrompt: "Provider 标识（如 gateway、deepseek、work-claude）：",
    defaultBadge: "默认",
    setDefault: "启用",
    alreadyDefault: "使用中",
    editingDefault: "正在编辑当前启用的 Provider",
    editingOther: "正在浏览该配置 — 点「启用」后才会在运行时生效",
    protocol: "协议",
    protocolHint: "适配不同服务的请求格式",
    apiBaseHint: "支持官方或兼容服务地址",
    providerId: "Provider 标识",
    providerIdHint: "对应 settings.json 的 providers 键名；改名会同步更新引用",
    model: "模型",
    modelHint: "别名对应的上游模型 ID",
    modelsRoutingTitle: "模型与路由",
    modelsRoutingHint:
      "对应 models 别名目录，以及 default_model 与意图路由（classifier / L0 / L1 / L2）。",
    modelAlias: "别名",
    modelProvider: "所属 Provider",
    modelUpstream: "上游模型",
    modelPickEmpty: "暂无模型列表 — 可直接输入，或点「查看模型列表」同步",
    aliasPickEmpty: "暂无别名 — 可直接输入",
    addModel: "添加别名",
    removeModel: "删除",
    defaultModel: "默认模型",
    defaultModelHint: "关闭路由时使用（也可作为对话默认）",
    routingEnabled: "意图路由",
    routingEnabledHint: "按任务复杂度选择模型（Vera L0–L2）",
    routingClassifier: "分类器",
    routingL0: "L0（简单）",
    routingL1: "L1（默认）",
    routingL2: "L2（复杂）",
    addAsAlias: "添加为别名",
    keySaved:
      "已保存（默认掩码；点「显示」可查看当前默认项密钥，或输入新值覆盖）",
    keyMissing: "尚未保存密钥",
    keyReplacePlaceholder: "输入新密钥以覆盖",
    keyPlaceholder: "输入 API Key",
    showKey: "显示",
    hideKey: "隐藏",
    saving: "正在保存…",
    saved: "已自动保存",
    keySavedStatus: "密钥已自动保存到 Vera settings.json",
    refresh: "刷新",
    inspectTimeout:
      "读取超时。如果应用已在运行，请重启 Partner，让新的 sidecar 命令生效。",
    editJson: "编辑 JSON",
    editJsonProjectHint:
      "当前生效的是项目配置（.vera/settings.json），点击将编辑它。",
    editJsonGlobal: "编辑全局配置",
    configPathMissing: "找不到 settings.json 路径。",
    testConnection: "测试连接",
    viewModels: "查看模型列表",
    testingConnection: "正在测试连接…",
    testSuccess: (count: number) =>
      count > 0
        ? `连接成功，发现 ${count} 个模型。`
        : "连接成功，但未返回模型列表。",
    testFailed: "连接失败",
    testTimeout: "连接测试超时，请检查网络或 API Base URL。",
    modelListTitle: "可用模型",
    modelListHint: "本地配置模型即时显示；远程模型通过供应商 API 同步。",
    loadingModels: "正在加载模型列表…",
    modelListTimeout: "远程模型同步超时，仅显示本地配置模型。",
    modelListEmpty: "未找到可用模型。",
    modelSourceConfig: "配置",
    modelSourceRemote: "远程",
    hideModels: "收起",
    emptyProviders: "settings.json 里还没有 providers，先新建一套配置。",
    emptyModels: "还没有模型别名，可手动添加或从远程列表点选。",
  };
});

const SECTION_IDS = ["appearance", "llm", "editor", "storage"] as const;
type SectionId = (typeof SECTION_IDS)[number];

const navItems = computed<Array<{ id: SectionId; label: string }>>(() => [
  { id: "appearance", label: copy.value.appearanceTitle },
  { id: "llm", label: copy.value.llmTitle },
  { id: "editor", label: settings.locale === "en" ? "Editor" : "编辑器" },
  {
    id: "storage",
    label: settings.locale === "en" ? "Cache & storage" : "缓存与存储",
  },
]);

const scrollRef = ref<HTMLElement | null>(null);
const sectionRefs = new Map<SectionId, HTMLElement>();
const activeSection = ref<SectionId>("appearance");
let scrollFrame = 0;

function setSectionRef(id: SectionId, element: unknown) {
  const host =
    element instanceof HTMLElement
      ? element
      : (element as { $el?: unknown } | null)?.$el instanceof HTMLElement
        ? (element as { $el: HTMLElement }).$el
        : null;
  if (host) sectionRefs.set(id, host);
  else sectionRefs.delete(id);
}

function sectionOffsets(): SectionOffset[] {
  const container = scrollRef.value;
  if (!container) return [];
  const base = container.getBoundingClientRect().top - container.scrollTop;
  return SECTION_IDS.flatMap((id) => {
    const element = sectionRefs.get(id);
    if (!element) return [];
    return [{ id, top: element.getBoundingClientRect().top - base }];
  });
}

function syncActiveSection() {
  const container = scrollRef.value;
  if (!container) return;
  activeSection.value = pickActiveSection(
    sectionOffsets(),
    container.scrollTop,
    {
    atBottom: isScrolledToBottom(
      container.scrollTop,
      container.clientHeight,
        container.scrollHeight
    ),
}
  ) as SectionId;
}

function onSettingsScroll() {
  if (scrollFrame) return;
  scrollFrame = requestAnimationFrame(() => {
    scrollFrame = 0;
    syncActiveSection();
  });
}

function goToSection(id: SectionId) {
  activeSection.value = id;
  sectionRefs.get(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

const apiBaseHint = computed(() => {
  if (settings.provider.protocol === "openai-compatible") {
    return settings.locale === "en"
      ? "OpenAI Chat Completions gateways may omit /v1; Partner adds it automatically."
      : "OpenAI Chat Completions 网关可只填域名，缺少 /v1 时会自动补上。";
  }
  if (settings.provider.protocol === "openai-responses") {
    return settings.locale === "en"
      ? "Responses API uses /v1/responses. Most Claude-compatible gateways need OpenAI Chat Completions instead."
      : "Responses API 走 /v1/responses。多数 Claude 兼容网关应选「OpenAI Chat Completions」。";
  }
  return copy.value.apiBaseHint;
});

function clearStatus() {
  status.value = "";
  error.value = "";
}

function mergeModels(
  configured: CatalogModel[],
  remote: CatalogModel[]
): CatalogModel[] {
  if (!remote.length) return configured;
  const seen = new Set(remote.map((model) => model.id));
  const extras = configured.filter((model) => !seen.has(model.id));
  return [...remote, ...extras];
}

async function ensureLoaded() {
  if (!settings.isLoaded) {
    await settings.load(workspace.rootPath || undefined);
  }
  await modelCatalog.loadProviders(workspace.rootPath || undefined, true);
}

async function flushPendingLlmSettings() {
  if (apiKey.value.trim()) {
    await saveApiKeyIfNeeded();
  }
  await saveConfig(editingIsDefault.value);
}

function scheduleAppearanceSave() {
  if (!isReady.value) return;
  settings.persistUi();
}

function scheduleLlmSave() {
  if (!isReady.value || isSavingConfig.value || isSwitchingProvider.value)
    return;
  clearStatus();
  status.value = copy.value.saving;
  if (saveTimer) {
    window.clearTimeout(saveTimer);
  }
  saveTimer = window.setTimeout(() => {
    // Autosave never promotes a browsed profile to default.
    void saveConfig(editingIsDefault.value);
  }, 350);
}

async function saveConfig(setAsDefault = false) {
  clearStatus();
  isSavingConfig.value = true;
  try {
    await settings.save(workspace.rootPath || undefined, { setAsDefault });
    await modelCatalog.loadProviders(workspace.rootPath || undefined, true);
    await resolveSettingsJsonPath();
    status.value = copy.value.saved;
  } catch (saveError) {
    error.value =
      saveError instanceof Error ? saveError.message : String(saveError);
  } finally {
    isSavingConfig.value = false;
  }
}

function selectProviderProfile(provider: CatalogProvider) {
  if (provider.id === settings.provider.id) return;
  if (saveTimer) {
    window.clearTimeout(saveTimer);
    saveTimer = undefined;
  }
  isSwitchingProvider.value = true;
  settings.editCatalogProvider(provider);
  providerIdDraft.value = provider.id;
  apiKey.value = "";
  loadedApiKey.value = null;
  revealApiKey.value = false;
  showModelList.value = false;
  connectionTestFeedback.value = null;
  status.value = "";
  error.value = "";
  void nextTick(() => {
    isSwitchingProvider.value = false;
  });
}

async function commitProviderRename() {
  const next = providerIdDraft.value.trim().replace(/\s+/g, "-");
  if (!next || next === settings.provider.id) {
    providerIdDraft.value = settings.provider.id;
    return;
  }
  clearStatus();
  isSavingConfig.value = true;
  try {
    await settings.renameProvider(
      settings.provider.id,
      next,
      workspace.rootPath || undefined
    );
    providerIdDraft.value = settings.provider.id;
    await modelCatalog.loadProviders(workspace.rootPath || undefined, true);
    status.value = copy.value.saved;
  } catch (renameError) {
    error.value =
      renameError instanceof Error ? renameError.message : String(renameError);
    providerIdDraft.value = settings.provider.id;
  } finally {
    isSavingConfig.value = false;
  }
}

function scheduleModelsRoutingSave() {
  if (!isReady.value || isSavingConfig.value || isSwitchingProvider.value)
    return;
  clearStatus();
  status.value = copy.value.saving;
  if (modelsRoutingTimer) {
    window.clearTimeout(modelsRoutingTimer);
  }
  modelsRoutingTimer = window.setTimeout(() => {
    void (async () => {
      isSavingConfig.value = true;
      try {
        await settings.saveModelsRouting(workspace.rootPath || undefined);
        status.value = copy.value.saved;
      } catch (saveError) {
        error.value =
          saveError instanceof Error ? saveError.message : String(saveError);
      } finally {
        isSavingConfig.value = false;
      }
    })();
  }, 350);
}

function addModelAlias() {
  const alias = `model-${settings.modelAliases.length + 1}`;
  settings.modelAliases.push({
    alias,
    provider: settings.provider.id,
    model: "",
  });
  if (!settings.defaultModel) {
    settings.defaultModel = alias;
  }
  scheduleModelsRoutingSave();
}

function removeModelAlias(alias: string) {
  settings.modelAliases = settings.modelAliases.filter(
    (item) => item.alias !== alias
  );
  if (settings.defaultModel === alias) {
    settings.defaultModel = settings.modelAliases[0]?.alias ?? "";
  }
  for (const key of ["classifier", "l0", "l1", "l2"] as const) {
    if (settings.routing[key] === alias) {
      settings.routing[key] = "";
    }
  }
  scheduleModelsRoutingSave();
}

function createProviderProfile() {
  const id = window.prompt(copy.value.newProviderPrompt)?.trim();
  if (!id) return;
  settings.createProviderProfile(id);
  providerIdDraft.value = settings.provider.id;
  apiKey.value = "";
  loadedApiKey.value = null;
  revealApiKey.value = false;
  void saveConfig(providerProfiles.value.length === 0);
}

async function makeProviderDefault() {
  await saveConfig(true);
}

async function resolveGlobalSettingsPath(
  fromInspect?: string | null
): Promise<string> {
  if (fromInspect) return fromInspect;
  try {
    return await join(await homeDir(), ".vera", "settings.json");
  } catch {
    return "";
  }
}

async function resolveSettingsJsonPath() {
  const projectFallback = workspace.rootPath
    ? `${workspace.rootPath.replace(/\/$/, "")}/.vera/settings.json`
    : "";
  try {
    const config = await withTimeout(
      inspectLlmConfig(workspace.rootPath || undefined, null, false),
      INSPECT_TIMEOUT_MS,
      copy.value.inspectTimeout
    );
    const scope =
      config.configScope === "project" ||
      config.configScope === "global" ||
      config.configScope === "env" ||
      config.configScope === "explicit"
        ? config.configScope
        : "";
    configScope.value = scope;
    settingsJsonPath.value = config.configPath || projectFallback;
    globalSettingsJsonPath.value = await resolveGlobalSettingsPath(
      config.globalConfigPath
    );
  } catch {
    configScope.value = "";
    settingsJsonPath.value = projectFallback;
    globalSettingsJsonPath.value = await resolveGlobalSettingsPath(null);
    if (!projectFallback && globalSettingsJsonPath.value) {
      settingsJsonPath.value = globalSettingsJsonPath.value;
      configScope.value = "global";
    }
  }
}

async function openConfigJson(path = settingsJsonPath.value) {
  const target =
    path ||
    settingsJsonPath.value ||
    (workspace.rootPath
      ? `${workspace.rootPath.replace(/\/$/, "")}/.vera/settings.json`
      : globalSettingsJsonPath.value);
  if (!target) {
    error.value = copy.value.configPathMissing;
    return;
  }
  try {
    const content = await readFile(target);
    preview.openCodeFile(target, content);
  } catch (openError) {
    // Missing file: open an empty object so the user can create it via save.
    const message =
      openError instanceof Error ? openError.message : String(openError);
    if (/not found|no such file|ENOENT/i.test(message)) {
      preview.openCodeFile(target, "{\n}\n");
      return;
    }
    error.value = message;
  }
}

function openEditJsonHint() {
  if (editJsonHintTimer !== undefined) {
    window.clearTimeout(editJsonHintTimer);
    editJsonHintTimer = undefined;
  }
  if (showProjectConfigHint.value) {
    editJsonHintOpen.value = true;
  }
}

function closeEditJsonHint(delayMs = 140) {
  if (editJsonHintTimer !== undefined) {
    window.clearTimeout(editJsonHintTimer);
  }
  editJsonHintTimer = window.setTimeout(() => {
    editJsonHintOpen.value = false;
    editJsonHintTimer = undefined;
  }, delayMs);
}

function onEditJsonFocusOut(event: FocusEvent) {
  const wrap = event.currentTarget as HTMLElement | null;
  const next = event.relatedTarget as Node | null;
  if (wrap && next && wrap.contains(next)) return;
  closeEditJsonHint();
}

async function openGlobalConfigJson() {
  editJsonHintOpen.value = false;
  const path =
    globalSettingsJsonPath.value || (await resolveGlobalSettingsPath(null));
  if (!path) {
    error.value = copy.value.configPathMissing;
    return;
  }
  await openConfigJson(path);
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string
): Promise<T> {
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
      }
    );
  });
}

async function testConnection() {
  connectionTestFeedback.value = null;
  isTestingConnection.value = true;
  try {
    await flushPendingLlmSettings();
    const result = await withTimeout(
      testLlmConnection(workspace.rootPath || undefined, settings.provider.id, {
        protocol: settings.provider.protocol,
      }),
      REMOTE_MODEL_TIMEOUT_MS,
      copy.value.testTimeout
    );
    if (result.ok) {
      connectionTestFeedback.value = {
        type: "success",
        message: copy.value.testSuccess(result.modelCount),
      };
      return;
    }
    connectionTestFeedback.value = {
      type: "error",
      message: result.message || copy.value.testFailed,
    };
  } catch (testError) {
    connectionTestFeedback.value = {
      type: "error",
      message:
        testError instanceof Error ? testError.message : String(testError),
    };
  } finally {
    isTestingConnection.value = false;
  }
}

async function loadModelList() {
  modelListError.value = "";
  isLoadingModels.value = true;
  modelList.value = [];
  try {
    await flushPendingLlmSettings();
    const configured = await listLlmProviderModels(
      workspace.rootPath || undefined,
      settings.provider.id
    );
    modelList.value = configured.map((model) => ({
      ...model,
      source: "config" as const,
    }));
    try {
      const remote = await withTimeout(
        refreshLlmProviderModels(
          workspace.rootPath || undefined,
          settings.provider.id,
          {
          protocol: settings.provider.protocol,
          }
        ),
        REMOTE_MODEL_TIMEOUT_MS,
        copy.value.modelListTimeout
      );
      if (remote.length) {
        modelList.value = mergeModels(modelList.value, remote);
      }
    } catch (remoteError) {
      if (!modelList.value.length) {
        modelListError.value =
          remoteError instanceof Error
            ? remoteError.message
            : String(remoteError);
      }
    }
    // Keep combobox options in sync with the settings list panel.
    modelCatalog.$patch((state) => {
      state.modelsByProvider = {
        ...state.modelsByProvider,
        [settings.provider.id]: modelList.value,
      };
    });
  } catch (loadError) {
    modelListError.value =
      loadError instanceof Error ? loadError.message : String(loadError);
  } finally {
    isLoadingModels.value = false;
  }
}

async function toggleModelList() {
  if (showModelList.value) {
    showModelList.value = false;
    return;
  }
  clearStatus();
  showModelList.value = true;
  await loadModelList();
}

function selectModel(model: CatalogModel) {
  const alias = model.id;
  const upstream = model.upstreamId || model.id;
  const index = settings.modelAliases.findIndex((item) => item.alias === alias);
  const entry = {
    alias,
    provider: settings.provider.id,
    model: upstream === alias ? undefined : upstream,
  };
  if (index >= 0) {
    settings.modelAliases[index] = entry;
  } else {
    settings.modelAliases.push(entry);
  }
  if (!settings.defaultModel) {
    settings.defaultModel = alias;
  }
  settings.provider.model = alias;
  scheduleModelsRoutingSave();
  status.value = copy.value.saved;
}

function onApiKeyFocus() {
  apiKeyFocused.value = true;
  if (!apiKey.value && revealApiKey.value && loadedApiKey.value) {
    apiKey.value = loadedApiKey.value;
  }
}

function onApiKeyInput(event: Event) {
  const target = event.target as HTMLInputElement;
  apiKey.value = target.value === API_KEY_MASK ? "" : target.value;
}

async function toggleApiKeyReveal() {
  clearStatus();
  if (revealApiKey.value) {
    revealApiKey.value = false;
    if (apiKey.value && apiKey.value === loadedApiKey.value) {
      apiKey.value = "";
    }
    return;
  }
  try {
    const config = await withTimeout(
      inspectLlmConfig(workspace.rootPath || undefined, null, true),
      INSPECT_TIMEOUT_MS,
      copy.value.inspectTimeout
    );
    loadedApiKey.value = config.apiKeyValue ?? null;
    revealApiKey.value = true;
    if (!apiKeyFocused.value) apiKeyFocused.value = false;
  } catch (revealError) {
    error.value =
      revealError instanceof Error ? revealError.message : String(revealError);
  }
}

async function saveApiKeyIfNeeded() {
  apiKeyFocused.value = false;
  clearStatus();
  const nextKey = apiKey.value.trim();
  if (!nextKey || nextKey === API_KEY_MASK) return;
  if (loadedApiKey.value && nextKey === loadedApiKey.value) {
    apiKey.value = "";
    return;
  }
  try {
    await settings.saveApiKey(
      nextKey,
      workspace.rootPath || undefined,
      editingIsDefault.value
    );
    loadedApiKey.value = nextKey;
    apiKey.value = "";
    revealApiKey.value = false;
    await modelCatalog.loadProviders(workspace.rootPath || undefined, true);
    await resolveSettingsJsonPath();
    status.value = copy.value.keySavedStatus;
  } catch (saveError) {
    error.value =
      saveError instanceof Error ? saveError.message : String(saveError);
  }
}

function onProtocolChange(value: string) {
  settings.setProtocol(value as LLMProtocol);
}

function onLocaleChange(value: string) {
  settings.setLocale(value as AppLocale);
}

function onThemeChange(value: string) {
  settings.setTheme(value as Exclude<AppThemeId, "custom">);
}

function onCustomPaletteSelect(value: string) {
  settings.setCustomPalette(value as CustomPaletteId);
}

function onWallpaperModeChange(value: string) {
  settings.setWallpaperMode(value as WallpaperMode);
}

function onWallpaperOpacityChange(event: Event) {
  const target = event.target as HTMLInputElement;
  settings.setWallpaperOpacity(Number(target.value));
}

function flushWallpaperBlur(value = wallpaperBlurDraft.value) {
  if (blurApplyTimer !== undefined) {
    window.clearTimeout(blurApplyTimer);
    blurApplyTimer = undefined;
  }
  if (settings.wallpaperBlur !== value) {
    settings.setWallpaperBlur(value);
  }
}

function scheduleWallpaperBlur(value: number) {
  wallpaperBlurDraft.value = value;
  if (blurApplyTimer !== undefined) {
    window.clearTimeout(blurApplyTimer);
  }
  blurApplyTimer = window.setTimeout(() => {
    blurApplyTimer = undefined;
    flushWallpaperBlur(value);
  }, WALLPAPER_BLUR_DEBOUNCE_MS);
}

function onWallpaperBlurInput(event: Event) {
  const target = event.target as HTMLInputElement;
  scheduleWallpaperBlur(Number(target.value));
}

function onWallpaperBlurCommit(event: Event) {
  const target = event.target as HTMLInputElement;
  wallpaperBlurDraft.value = Number(target.value);
  flushWallpaperBlur(wallpaperBlurDraft.value);
}

function openWallpaperPicker() {
  wallpaperInput.value?.click();
}

async function onWallpaperFileChange(event: Event) {
  const target = event.target as HTMLInputElement;
  const file = target.files?.[0];
  target.value = "";
  if (!file) return;
  wallpaperBusy.value = true;
  clearStatus();
  try {
    await settings.setCustomWallpaper(file);
    status.value = copy.value.wallpaperReady;
  } catch (uploadError) {
    error.value =
      uploadError instanceof Error ? uploadError.message : String(uploadError);
  } finally {
    wallpaperBusy.value = false;
  }
}

function clearWallpaperImage() {
  settings.clearCustomWallpaper();
}

onMounted(() => {
  void (async () => {
    await ensureLoaded();
    await resolveSettingsJsonPath();
    ensureAliasProviderModels();
    isReady.value = true;
    await nextTick();
    syncActiveSection();
  })();
});

onBeforeUnmount(() => {
  if (scrollFrame) {
    cancelAnimationFrame(scrollFrame);
  }
  if (saveTimer) {
    window.clearTimeout(saveTimer);
  }
  if (modelsRoutingTimer) {
    window.clearTimeout(modelsRoutingTimer);
  }
  if (editJsonHintTimer !== undefined) {
    window.clearTimeout(editJsonHintTimer);
  }
  flushWallpaperBlur();
});

watch(
  () => settings.wallpaperBlur,
  (value) => {
    if (blurApplyTimer === undefined) {
      wallpaperBlurDraft.value = value;
    }
  }
);

watch(
  () => settings.provider.protocol,
  async () => {
    if (!showModelList.value) return;
    await loadModelList();
  }
);

watch(
  () => [
    settings.locale,
    settings.theme,
    settings.wallpaperMode,
    settings.wallpaperOpacity,
    settings.wallpaperBlur,
    settings.customPaletteId,
  ],
  scheduleAppearanceSave
);

// Do not watch provider.id — chip switches must not autosave/promote defaults.
watch(
  () => [
    settings.provider.protocol,
    settings.provider.apiBaseUrl,
    settings.provider.model,
  ],
  scheduleLlmSave
);

watch(
  () => workspace.rootPath,
  () => {
    void resolveSettingsJsonPath();
  }
);

watch(
  () => settings.provider.id,
  (id) => {
    providerIdDraft.value = id;
  }
);
</script>

<template>
  <section class="settings-panel">
    <div class="settings-header">
      <div class="settings-header-row">
      <h2>{{ copy.title }}</h2>
        <!-- Save / connection feedback belongs next to the title: it applies to
             the whole page, and inline it reads as a comment on whichever
             section happens to sit above it. -->
        <p
          v-if="connectionTestFeedback"
          class="header-feedback"
          :class="connectionTestFeedback.type"
          role="status"
        >
          {{ connectionTestFeedback.message }}
        </p>
        <p v-else-if="error" class="header-feedback error" role="status">
          {{ error }}
        </p>
        <p v-else-if="status" class="header-feedback" role="status">
          {{ status }}
        </p>
    </div>
      <p class="settings-description">{{ copy.description }}</p>
    </div>

    <div class="settings-body">
      <nav class="settings-nav" :aria-label="copy.title">
        <button
          v-for="item in navItems"
          :key="item.id"
          type="button"
          class="settings-nav-item"
          :class="{ active: activeSection === item.id }"
          :aria-current="activeSection === item.id ? 'true' : undefined"
          @click="goToSection(item.id)"
        >
          {{ item.label }}
        </button>
      </nav>

      <div ref="scrollRef" class="settings-scroll" @scroll="onSettingsScroll">
    <section
      :ref="(el) => setSectionRef('appearance', el)"
      class="settings-section"
    >
      <div class="section-heading">
        <strong>{{ copy.appearanceTitle }}</strong>
        <small>{{ copy.appearanceHint }}</small>
      </div>
      <div class="settings-card">
        <div class="setting-row">
          <span class="setting-label">
            <strong>{{ copy.language }}</strong>
            <small>{{ copy.languageHint }}</small>
          </span>
          <PartnerSelect
            :model-value="settings.locale"
            :options="localeSelectOptions"
            :aria-label="copy.language"
            @update:model-value="onLocaleChange"
          />
        </div>

        <div class="setting-row">
          <span class="setting-label">
            <strong>{{ copy.theme }}</strong>
            <small>{{ copy.themeHint }}</small>
          </span>
          <PartnerSelect
            :model-value="themeSelectValue"
            :options="themeSelectOptions"
            :display-option="themeTriggerOption"
            :emphasized="settings.theme === 'custom'"
            :aria-label="copy.theme"
            @update:model-value="onThemeChange"
          />
        </div>

        <div class="setting-row wallpaper-row">
          <span class="setting-label">
            <strong>{{ copy.wallpaper }}</strong>
            <small>{{ copy.wallpaperHint }}</small>
          </span>
          <div class="wallpaper-controls">
            <PartnerSelect
              :model-value="settings.wallpaperMode"
              :groups="wallpaperSelectGroups"
              :aria-label="copy.wallpaper"
              @update:model-value="onWallpaperModeChange"
            />

            <div class="wallpaper-actions">
              <input
                ref="wallpaperInput"
                class="wallpaper-file"
                type="file"
                accept="image/*"
                @change="onWallpaperFileChange"
              />
              <button
                type="button"
                class="wallpaper-button"
                :disabled="wallpaperBusy"
                @click="openWallpaperPicker"
              >
                    {{
                      wallpaperBusy
                        ? copy.wallpaperUploading
                        : copy.wallpaperUpload
                    }}
              </button>
              <button
                v-if="settings.wallpaperDataUrl"
                type="button"
                class="wallpaper-button secondary"
                @click="clearWallpaperImage"
              >
                {{ copy.wallpaperClear }}
              </button>
            </div>

            <template v-if="showWallpaperTuning">
              <label class="wallpaper-opacity">
                    <span
                      >{{ copy.wallpaperOpacity }} ·
                      {{ Math.round(settings.wallpaperOpacity * 100) }}%</span
                    >
                <input
                  type="range"
                  :min="MIN_WALLPAPER_OPACITY"
                  :max="MAX_WALLPAPER_OPACITY"
                  step="0.01"
                  :value="settings.wallpaperOpacity"
                  @input="onWallpaperOpacityChange"
                />
              </label>

              <label class="wallpaper-opacity">
                    <span
                      >{{ copy.wallpaperBlur }} ·
                      {{ Math.round(wallpaperBlurDraft) }}px</span
                    >
                <input
                  type="range"
                  :min="MIN_WALLPAPER_BLUR"
                  :max="MAX_WALLPAPER_BLUR"
                  step="1"
                  :value="wallpaperBlurDraft"
                  @input="onWallpaperBlurInput"
                  @change="onWallpaperBlurCommit"
                />
              </label>
            </template>

            <div
              v-if="wallpaperPreviewUrl"
              class="wallpaper-preview"
              :style="{ backgroundImage: `url(${wallpaperPreviewUrl})` }"
              aria-hidden="true"
            />

            <div v-if="showCustomPalettes" class="custom-palettes">
              <div class="custom-palettes-header">
                <strong>{{ copy.customPalettes }}</strong>
                <small>{{ copy.customPalettesHint }}</small>
              </div>
                  <p
                    v-if="settings.customPalettesLoading"
                    class="custom-palettes-status"
                  >
                {{ copy.customPalettesLoading }}
              </p>
              <p
                v-else-if="settings.customPalettes.length === 0"
                class="custom-palettes-status"
              >
                {{ copy.customPalettesEmpty }}
              </p>
              <PartnerSelect
                v-else
                :model-value="customPaletteSelectValue"
                :options="customPaletteSelectOptions"
                :placeholder="copy.customPalettesPlaceholder"
                :emphasized="settings.theme === 'custom'"
                :aria-label="copy.customPalettes"
                @update:model-value="onCustomPaletteSelect"
              />
            </div>
          </div>
        </div>
      </div>
    </section>

    <section
      :ref="(el) => setSectionRef('llm', el)"
      class="settings-section section-divided"
    >
      <div class="section-heading">
        <div class="section-heading-row">
          <strong>{{ copy.llmTitle }}</strong>
          <div
            class="edit-json-wrap"
            @mouseenter="openEditJsonHint"
            @mouseleave="closeEditJsonHint()"
            @focusin="openEditJsonHint"
            @focusout="onEditJsonFocusOut"
          >
            <button
              type="button"
              class="link-button heading-action"
              :disabled="!settingsJsonPath && !globalSettingsJsonPath"
              @click="openConfigJson()"
            >
              {{ copy.editJson }}
            </button>
            <div
              v-if="showProjectConfigHint && editJsonHintOpen"
              class="edit-json-popover"
              role="tooltip"
              @mouseenter="openEditJsonHint"
              @mouseleave="closeEditJsonHint()"
            >
              <p>{{ copy.editJsonProjectHint }}</p>
              <button
                type="button"
                class="link-button"
                :disabled="!globalSettingsJsonPath"
                @click="openGlobalConfigJson"
              >
                {{ copy.editJsonGlobal }}
              </button>
            </div>
          </div>
        </div>
        <small>{{ copy.llmHint }}</small>
      </div>

      <div class="provider-toolbar">
            <div
              class="provider-chips"
              role="tablist"
              :aria-label="copy.providersLabel"
            >
          <button
            v-for="provider in providerProfiles"
            :key="provider.id"
            type="button"
            class="provider-chip"
            :class="{
              active: provider.id === settings.provider.id,
              default: provider.isDefault,
            }"
            role="tab"
            :aria-selected="provider.id === settings.provider.id"
            @click="selectProviderProfile(provider)"
          >
            <span class="provider-chip-id">{{ provider.id }}</span>
                <span v-if="provider.isDefault" class="provider-badge">{{
                  copy.defaultBadge
                }}</span>
          </button>
          <button
            type="button"
            class="provider-chip create"
            @click="createProviderProfile"
          >
            + {{ copy.newProvider }}
          </button>
              <p v-if="!providerProfiles.length" class="provider-empty">
                {{ copy.emptyProviders }}
              </p>
        </div>
      </div>

      <p class="provider-edit-hint">
        {{ editingIsDefault ? copy.editingDefault : copy.editingOther }}
      </p>

      <div class="settings-card">
        <div class="setting-row">
          <span class="setting-label">
            <strong>{{ copy.providerId }}</strong>
            <small>{{ copy.providerIdHint }}</small>
          </span>
          <div class="provider-id-row">
            <input
              v-model.trim="providerIdDraft"
              type="text"
              :aria-label="copy.providerId"
              @blur="commitProviderRename"
              @keydown.enter.prevent="commitProviderRename"
            />
            <button
              type="button"
              class="action-button"
              :class="{ secondary: editingIsDefault }"
              :disabled="isSavingConfig || editingIsDefault"
              @click="makeProviderDefault"
            >
              {{ editingIsDefault ? copy.alreadyDefault : copy.setDefault }}
            </button>
          </div>
        </div>

        <div class="setting-row">
          <span class="setting-label">
            <strong>{{ copy.protocol }}</strong>
            <small>{{ copy.protocolHint }}</small>
          </span>
          <PartnerSelect
            :model-value="settings.provider.protocol"
            :options="protocolSelectOptions"
            :aria-label="copy.protocol"
            @update:model-value="onProtocolChange"
          />
        </div>

        <label class="setting-row">
          <span class="setting-label">
            <strong>API Base URL</strong>
            <small>{{ apiBaseHint }}</small>
          </span>
          <input
            v-model.trim="settings.provider.apiBaseUrl"
            type="url"
            placeholder="https://api.example.com/v1"
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
              :value="apiKeyDisplay"
              :type="revealApiKey ? 'text' : 'password'"
              autocomplete="new-password"
                  :placeholder="
                    settings.hasApiKey
                      ? copy.keyReplacePlaceholder
                      : copy.keyPlaceholder
                  "
              @focus="onApiKeyFocus"
              @input="onApiKeyInput"
              @blur="saveApiKeyIfNeeded"
              @keydown.enter.prevent="saveApiKeyIfNeeded"
            />
            <button
              v-if="settings.hasApiKey && editingIsDefault"
              type="button"
              class="link-button"
              @click="toggleApiKeyReveal"
            >
              {{ revealApiKey ? copy.hideKey : copy.showKey }}
            </button>
          </span>
        </label>
      </div>

      <div class="section-heading models-routing-heading">
        <strong>{{ copy.modelsRoutingTitle }}</strong>
        <small>{{ copy.modelsRoutingHint }}</small>
      </div>

      <div class="settings-card">
        <div class="model-alias-list">
          <div
            v-for="(item, index) in settings.modelAliases"
            :key="`${item.alias}-${index}`"
            class="model-alias-row"
          >
            <input
              v-model.trim="item.alias"
              type="text"
              :placeholder="copy.modelAlias"
              :aria-label="copy.modelAlias"
              @change="scheduleModelsRoutingSave"
            />
            <PartnerSelect
              :model-value="item.provider"
              :options="providerSelectOptions"
              :aria-label="copy.modelProvider"
              @update:model-value="
                (value) => {
                  item.provider = String(value);
                  ensureProviderModelOptions(String(value));
                  scheduleModelsRoutingSave();
                }
              "
            />
            <PartnerCombobox
              :model-value="item.model ?? ''"
              :options="upstreamModelOptions(item.provider)"
              :placeholder="copy.modelUpstream"
              :aria-label="copy.modelUpstream"
              :empty-label="copy.modelPickEmpty"
              @update:model-value="
                (value) => {
                  item.model = value;
                }
              "
              @change="scheduleModelsRoutingSave"
              @open="ensureProviderModelOptions(item.provider)"
            />
            <button
              type="button"
              class="link-button"
              @click="removeModelAlias(item.alias)"
            >
              {{ copy.removeModel }}
            </button>
          </div>
          <p v-if="!settings.modelAliases.length" class="provider-empty">
            {{ copy.emptyModels }}
          </p>
          <button type="button" class="link-button" @click="addModelAlias">
            + {{ copy.addModel }}
          </button>
        </div>

        <label class="setting-row">
          <span class="setting-label">
            <strong>{{ copy.defaultModel }}</strong>
            <small>{{ copy.defaultModelHint }}</small>
          </span>
          <PartnerCombobox
            :model-value="settings.defaultModel"
            :options="modelAliasOptions"
            :aria-label="copy.defaultModel"
            :empty-label="copy.aliasPickEmpty"
            @update:model-value="
              (value) => {
                settings.defaultModel = value;
              }
            "
            @change="scheduleModelsRoutingSave"
          />
        </label>

        <label class="setting-row setting-row-toggle">
          <span class="setting-label">
            <strong>{{ copy.routingEnabled }}</strong>
            <small>{{ copy.routingEnabledHint }}</small>
          </span>
          <input
            v-model="settings.routing.enabled"
            type="checkbox"
            @change="scheduleModelsRoutingSave"
          />
        </label>

        <template v-if="settings.routing.enabled">
          <label
            v-for="tier in [
              { key: 'classifier' as const, label: copy.routingClassifier },
              { key: 'l0' as const, label: copy.routingL0 },
              { key: 'l1' as const, label: copy.routingL1 },
              { key: 'l2' as const, label: copy.routingL2 },
            ]"
            :key="tier.key"
            class="setting-row"
          >
            <span class="setting-label">
              <strong>{{ tier.label }}</strong>
            </span>
            <PartnerCombobox
              :model-value="settings.routing[tier.key] ?? ''"
              :options="modelAliasOptions"
              :aria-label="tier.label"
              :empty-label="copy.aliasPickEmpty"
              @update:model-value="
                (value) => {
                  settings.routing[tier.key] = value;
                }
              "
              @change="scheduleModelsRoutingSave"
            />
          </label>
        </template>
      </div>

      <div class="settings-actions">
        <button
          type="button"
          class="action-button"
          :disabled="isTestingConnection || isSavingConfig"
          @click="testConnection"
        >
              {{
                isTestingConnection
                  ? copy.testingConnection
                  : copy.testConnection
              }}
        </button>
        <button
          type="button"
          class="action-button secondary"
          :disabled="isLoadingModels || isSavingConfig"
          @click="toggleModelList"
        >
          {{ showModelList ? copy.hideModels : copy.viewModels }}
        </button>
      </div>
    </section>

    <section v-if="showModelList" class="model-list-card">
      <div class="model-list-header">
        <span>
          <strong>{{ copy.modelListTitle }}</strong>
          <small>{{ copy.modelListHint }}</small>
        </span>
            <button
              type="button"
              class="link-button"
              :disabled="isLoadingModels"
              @click="loadModelList"
            >
          {{ copy.refresh }}
        </button>
      </div>
      <p v-if="isLoadingModels" class="status">{{ copy.loadingModels }}</p>
          <p v-else-if="modelListError" class="status error">
            {{ modelListError }}
          </p>
          <p v-else-if="!modelList.length" class="status">
            {{ copy.modelListEmpty }}
          </p>
      <ul v-else class="model-list">
        <li v-for="model in modelList" :key="model.id">
              <button
                type="button"
                class="model-item"
                @click="selectModel(model)"
              >
            <span class="model-id">{{ model.id }}</span>
                <span
                  v-if="model.displayName && model.displayName !== model.id"
                  class="model-alias"
                >
              {{ model.displayName }}
            </span>
            <span v-if="model.source" class="model-source">
                  {{
                    model.source === "config"
                      ? copy.modelSourceConfig
                      : copy.modelSourceRemote
                  }}
            </span>
          </button>
        </li>
      </ul>
    </section>

        <EditorSettingsSection
          :ref="(el) => setSectionRef('editor', el)"
          class="section-divided"
        />
        <StorageUsageSection
          :ref="(el) => setSectionRef('storage', el)"
          class="section-divided"
        />
      </div>
    </div>
  </section>
</template>

<style scoped>
.settings-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
  padding: 18px 18px 0;
  color: var(--text);
  container-type: inline-size;
}

.settings-body {
  display: flex;
  flex: 1;
  min-height: 0;
  gap: 20px;
}

/* Vertical table of contents; sticks while the content scrolls. */
.settings-nav {
  display: flex;
  flex: 0 0 auto;
  flex-direction: column;
  gap: 2px;
  width: 128px;
  padding-bottom: 18px;
}

.settings-nav-item {
  border: none;
  border-left: 2px solid transparent;
  border-radius: 0 4px 4px 0;
  padding: 7px 10px;
  background: transparent;
  color: var(--text-muted);
  font: inherit;
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}

.settings-nav-item:hover {
  background: color-mix(in srgb, var(--text) 6%, transparent);
  color: var(--text);
}

.settings-nav-item.active {
  border-left-color: var(--accent);
  background: color-mix(in srgb, var(--accent) 12%, transparent);
  color: var(--text);
  font-weight: 600;
}

.settings-scroll {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
  padding-bottom: 18px;
  scroll-behavior: smooth;
}

@container (max-width: 620px) {
  /* Stay vertical at every width — the rail reads as a table of contents. Only
     its width shrinks so the content column keeps a usable measure. */
  .settings-body {
    gap: 12px;
  }

  .settings-nav {
    width: 92px;
  }

  .settings-nav-item {
    padding: 7px 8px;
    font-size: 11px;
  }
}

.settings-header {
  width: min(100%, 780px);
  margin-bottom: 16px;
}

.settings-header-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 16px;
}

.header-feedback {
  margin: 0;
  overflow: hidden;
  color: var(--accent);
  font-size: 12px;
  text-align: right;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.header-feedback.error {
  color: var(--danger-muted);
}

.header-feedback.success {
  color: var(--success, #4ade80);
}

.settings-header h2 {
  margin: 0 0 6px;
  font-size: 18px;
  font-weight: 650;
}

.settings-description {
  margin: 0;
  color: var(--text-muted);
  font-size: 12px;
}

.settings-section {
  width: min(100%, 780px);
  margin-bottom: 28px;
}

/* Visible break between top-level settings blocks. */
.section-divided {
  margin-top: 28px;
  padding-top: 28px;
  border-top: 1px solid color-mix(in srgb, var(--text) 12%, transparent);
}

.section-heading {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-bottom: 10px;
}

.section-heading-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.section-heading strong {
  font-size: 13px;
  font-weight: 650;
}

.section-heading .heading-action {
  font-size: 12px;
}

.edit-json-wrap {
  position: relative;
  display: inline-flex;
  align-items: center;
}

.edit-json-popover {
  position: absolute;
  top: calc(100% + 6px);
  left: 0;
  z-index: 30;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 6px;
  min-width: 220px;
  max-width: 320px;
  padding: 8px 10px;
  border: 1px solid color-mix(in srgb, var(--border) 80%, transparent);
  border-radius: 8px;
  background: color-mix(in srgb, var(--surface-elevated) 96%, transparent);
  box-shadow: 0 8px 22px rgba(0, 0, 0, 0.28);
}

.edit-json-popover p {
  margin: 0;
  color: var(--text-muted);
  font-size: 11px;
  line-height: 1.45;
}

.edit-json-popover .link-button {
  color: var(--accent);
  font-size: 12px;
}

.section-heading small {
  color: var(--text-muted);
  font-size: 11px;
  line-height: 1.45;
}

.provider-toolbar {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 8px;
}

.provider-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  min-width: 0;
  flex: 1;
}

.provider-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 28px;
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 0 10px;
  background: color-mix(in srgb, var(--surface-elevated) 88%, transparent);
  color: var(--text-muted);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}

.provider-chip:hover {
  color: var(--text);
  background: var(--surface-hover);
}

.provider-chip.active {
  border-color: color-mix(in srgb, var(--accent) 55%, var(--border));
  background: color-mix(in srgb, var(--accent) 14%, var(--surface-elevated));
  color: var(--text);
}

.provider-chip.create {
  border-style: dashed;
  color: var(--text-muted);
}

.provider-chip.create:hover {
  border-style: solid;
  color: var(--text);
}

.provider-chip-id {
  font-weight: 600;
}

.provider-badge {
  border-radius: 999px;
  padding: 1px 6px;
  background: color-mix(in srgb, var(--accent) 22%, transparent);
  color: var(--accent);
  font-size: 10px;
  font-weight: 650;
}

.provider-empty {
  margin: 0;
  color: var(--text-muted);
  font-size: 12px;
}

.provider-edit-hint {
  margin: 0 0 10px;
  color: var(--text-muted);
  font-size: 11px;
}

.settings-card {
  width: 100%;
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface-elevated);
}

.models-routing-heading {
  margin-top: 18px;
}

.provider-id-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  min-width: 0;
}

.provider-id-row input {
  flex: 1 1 160px;
  min-width: 0;
}

.model-alias-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 14px;
  border-bottom: 1px solid var(--border);
}

.model-alias-row {
  display: grid;
  grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr) minmax(0, 1.2fr) auto;
  gap: 8px;
  align-items: center;
}

.model-alias-row input,
.model-alias-row :deep(.partner-combobox),
.model-alias-row :deep(.partner-select) {
  min-width: 0;
}

.setting-row-toggle input[type="checkbox"] {
  width: 16px;
  height: 16px;
  accent-color: var(--accent);
}

.settings-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  width: 100%;
  margin-top: 12px;
}

.action-button {
  min-height: 32px;
  border: 1px solid color-mix(in srgb, var(--accent) 42%, var(--border));
  border-radius: 6px;
  padding: 0 14px;
  background: color-mix(in srgb, var(--accent) 12%, var(--surface-elevated));
  color: var(--text);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}

.action-button:hover:not(:disabled) {
  border-color: color-mix(in srgb, var(--accent) 70%, var(--border));
  color: var(--accent);
}

.action-button:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.action-button.secondary {
  background: var(--surface-elevated);
}

.model-list-card {
  width: min(100%, 780px);
  margin-top: 12px;
  padding: 14px 16px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface-elevated);
}

.model-list-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 10px;
}

.model-list-header span {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.model-list-header strong {
  font-size: 13px;
  font-weight: 650;
}

.model-list-header small {
  color: var(--text-muted);
  font-size: 11px;
  line-height: 1.45;
}

.model-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 280px;
  margin: 0;
  padding: 0;
  overflow: auto;
  list-style: none;
}

.model-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-height: 32px;
  border: 1px solid color-mix(in srgb, var(--border) 88%, transparent);
  border-radius: 6px;
  padding: 6px 10px;
  background: var(--bg);
  color: var(--text);
  font: inherit;
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}

.model-item:hover {
  border-color: color-mix(in srgb, var(--accent) 50%, var(--border));
}

.model-id {
  font-family:
    ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
}

.model-alias,
.model-source {
  color: var(--text-muted);
  font-size: 11px;
}

.model-source {
  margin-left: auto;
  flex-shrink: 0;
  border-radius: 999px;
  padding: 1px 7px;
  background: color-mix(in srgb, var(--border) 60%, transparent);
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

.wallpaper-row {
  align-items: start;
  min-height: 0;
  padding-top: 14px;
  padding-bottom: 14px;
}

.wallpaper-controls {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
}

.wallpaper-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.wallpaper-file {
  display: none;
}

.wallpaper-button {
  min-height: 30px;
  border: 1px solid color-mix(in srgb, var(--accent) 42%, var(--border));
  border-radius: 6px;
  padding: 0 12px;
  background: color-mix(in srgb, var(--accent) 10%, var(--surface));
  color: var(--text);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}

.wallpaper-button.secondary {
  border-color: var(--border);
  background: var(--bg);
}

.wallpaper-button:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.wallpaper-opacity {
  display: flex;
  flex-direction: column;
  gap: 6px;
  color: var(--text-muted);
  font-size: 11px;
}

.wallpaper-opacity input[type="range"] {
  width: 100%;
  min-height: 0;
  padding: 0;
  border: none;
  background: transparent;
  accent-color: var(--accent);
}

.wallpaper-preview {
  width: 100%;
  height: 72px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background-position: center;
  background-size: cover;
  background-repeat: no-repeat;
}

.custom-palettes {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-top: 4px;
  border-top: 1px dashed color-mix(in srgb, var(--border) 80%, transparent);
}

.custom-palettes-header {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.custom-palettes-header strong {
  font-size: 12px;
  font-weight: 650;
}

.custom-palettes-header small,
.custom-palettes-status {
  color: var(--text-muted);
  font-size: 11px;
  line-height: 1.4;
}

.custom-palettes-status {
  margin: 0;
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

input {
  width: 100%;
  min-height: 30px;
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 0 9px;
  background: var(--bg-solid, var(--bg));
  color: var(--text);
  font: inherit;
  font-size: 12px;
}

input:focus {
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

.connection-feedback {
  max-width: 680px;
  margin: 10px 0 0;
  padding: 8px 10px;
  border-radius: 8px;
  font-size: 13px;
  line-height: 1.45;
}

.connection-feedback.success {
  border: 1px solid color-mix(in srgb, var(--accent) 42%, var(--border));
  background: color-mix(in srgb, var(--accent) 10%, var(--surface));
  color: var(--text);
}

.connection-feedback.error {
  border: 1px solid color-mix(in srgb, var(--danger) 50%, var(--border));
  background: color-mix(in srgb, var(--danger) 10%, var(--surface));
  color: var(--danger-muted);
}

.status.error {
  color: var(--danger-muted);
}

@container (max-width: 560px) {
  .settings-row,
  .setting-row {
    grid-template-columns: 1fr;
    align-items: stretch;
    gap: 8px;
  }

  .model-alias-row {
    grid-template-columns: 1fr;
  }
}
</style>
