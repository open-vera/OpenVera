import { defineStore } from "pinia";
import {
  inspectLlmConfig,
  renameVeraProvider,
  saveVeraLlmConfig,
  saveVeraModelsRouting,
} from "@/bridge";
import {
  applyPartnerTheme,
  BUILTIN_WALLPAPERS,
  clampWallpaperBlur,
  clampWallpaperOpacity,
  DEFAULT_WALLPAPER_BLUR,
  DEFAULT_WALLPAPER_OPACITY,
  extractCustomPalettes,
  isBuiltinWallpaperId,
  isCustomPaletteId,
  isWallpaperMode,
  normalizeThemeId,
  prepareWallpaperDataUrl,
  readStoredWallpaperDataUrl,
  resolveThemeId,
  resolveWallpaperImageUrl,
  themeDefaultWallpaper,
  writeStoredWallpaperDataUrl,
  type AppThemeId,
  type CustomPaletteId,
  type CustomPaletteVariant,
  type WallpaperMode,
} from "@/theme";
import type {
  AgentRunMode,
  AppLocale,
  CatalogProvider,
  EffectiveLlmConfig,
  LLMProvider,
  LLMProviderId,
  LLMProtocol,
  LLMRuntimeConfig,
  VeraModelAlias,
  VeraRoutingSettings,
} from "@/types";
import { resolveCatalogProtocol } from "@/utils/llm-protocol";
import type { VeraModelsRoutingSnapshot } from "@/utils/vera-config-edit";

const UI_SETTINGS_STORAGE_KEY = "partner:ui-settings";
const DEFAULT_API_KEY_REF = "llm:anthropic:api-key";

const DEFAULT_PROVIDER: LLMProvider = {
  id: "anthropic",
  protocol: "anthropic",
  apiBaseUrl: "https://api.anthropic.com",
  model: "claude-sonnet-4-20250514",
  apiKeyRef: DEFAULT_API_KEY_REF,
};

interface PersistedUiSettings {
  theme?: AppThemeId | "dark" | "light";
  maxInstances?: number;
  locale?: AppLocale;
  firstLaunchComplete?: boolean;
  agentMode?: AgentRunMode;
  wallpaperMode?: WallpaperMode;
  wallpaperOpacity?: number;
  wallpaperBlur?: number;
  customPaletteId?: CustomPaletteId | null;
}

function readStoredUiSettings(): PersistedUiSettings | null {
  try {
    const raw = window.localStorage.getItem(UI_SETTINGS_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as PersistedUiSettings) : null;
  } catch (error) {
    console.warn("[Settings] failed to read UI settings:", error);
    return null;
  }
}

function providerDefaults(id: LLMProviderId): LLMProvider {
  if (id === "openai") {
    return {
      id,
      protocol: "openai-compatible",
      apiBaseUrl: "https://api.openai.com/v1",
      model: "gpt-4.1",
      apiKeyRef: "llm:openai:api-key",
    };
  }
  if (id === "gemini") {
    return {
      id,
      protocol: "gemini",
      apiBaseUrl: "https://generativelanguage.googleapis.com",
      model: "gemini-1.5-pro",
      apiKeyRef: "llm:gemini:api-key",
    };
  }
  if (id === "anthropic") return { ...DEFAULT_PROVIDER };
  return {
    id,
    protocol: "anthropic",
    apiBaseUrl: "",
    model: "",
    apiKeyRef: `llm:${id}:api-key`,
  };
}

function protocolFromEffective(config: EffectiveLlmConfig): LLMProtocol {
  if (config.protocol === "openai-responses" || config.adapter === "openai-responses") {
    return "openai-responses";
  }
  if (config.protocol === "openai" || config.adapter === "openai") return "openai-compatible";
  if (config.protocol === "gemini" || config.adapter === "gemini") return "gemini";
  return "anthropic";
}

function providerFromEffective(config: EffectiveLlmConfig): LLMProvider {
  const provider = providerDefaults(config.provider);
  return {
    ...provider,
    id: config.provider,
    protocol: protocolFromEffective(config),
    apiBaseUrl: config.apiBaseUrl,
    model: config.model,
    apiKeyRef: `llm:${config.provider}:api-key`,
  };
}

export const useSettingsStore = defineStore("settings", {
  state: () => ({
    provider: { ...DEFAULT_PROVIDER },
    agentMode: "agent" as AgentRunMode,
    theme: "system" as AppThemeId,
    wallpaperMode: "theme" as WallpaperMode,
    wallpaperOpacity: DEFAULT_WALLPAPER_OPACITY,
    wallpaperBlur: DEFAULT_WALLPAPER_BLUR,
    wallpaperDataUrl: null as string | null,
    customPaletteId: null as CustomPaletteId | null,
    customPalettes: [] as CustomPaletteVariant[],
    customPalettesLoading: false,
    maxInstances: 3,
    locale: "zh" as AppLocale,
    firstLaunchComplete: false,
    hasApiKey: false,
    isLoaded: false,
    modelAliases: [] as VeraModelAlias[],
    defaultModel: "" as string,
    routing: {
      enabled: false,
      classifier: "",
      l0: "",
      l1: "",
      l2: "",
    } as VeraRoutingSettings & {
      classifier: string;
      l0: string;
      l1: string;
      l2: string;
    },
  }),
  getters: {
    activeCustomPalette(state): CustomPaletteVariant | null {
      if (state.theme !== "custom" || !state.customPaletteId) return null;
      return state.customPalettes.find((p) => p.id === state.customPaletteId) ?? null;
    },
  },
  actions: {
    applyModelsRoutingFromEffective(effective: EffectiveLlmConfig) {
      this.modelAliases = (effective.models ?? []).map((item) => ({
        alias: item.alias,
        provider: item.provider,
        model: item.model ?? "",
      }));
      this.defaultModel = effective.defaultModel ?? effective.model ?? "";
      const routing = effective.routing;
      this.routing = {
        enabled: Boolean(routing?.enabled),
        classifier: typeof routing?.classifier === "string" ? routing.classifier : "",
        l0: typeof routing?.l0 === "string" ? routing.l0 : "",
        l1: typeof routing?.l1 === "string" ? routing.l1 : "",
        l2: typeof routing?.l2 === "string" ? routing.l2 : "",
      };
    },
    currentWallpaperImageUrl(): string | null {
      const themeId =
        this.theme === "custom" ? resolveThemeId("system") : resolveThemeId(this.theme);
      return resolveWallpaperImageUrl({
        mode: this.wallpaperMode,
        customDataUrl: this.wallpaperDataUrl,
        themeBuiltin: themeDefaultWallpaper(themeId),
      });
    },
    applyAppearance() {
      const custom = this.activeCustomPalette;
      applyPartnerTheme(this.theme, {
        mode: this.wallpaperMode,
        customDataUrl: this.wallpaperDataUrl,
        opacity: this.wallpaperOpacity,
        blur: this.wallpaperBlur,
        customColors: custom?.colors ?? null,
        customScheme: custom?.scheme,
      });
    },
    async refreshCustomPalettes(selectDefault = false) {
      const imageUrl = this.currentWallpaperImageUrl();
      if (!imageUrl) {
        this.customPalettes = [];
        if (this.theme === "custom") {
          this.theme = "system";
          this.customPaletteId = null;
          this.applyAppearance();
        }
        return;
      }
      this.customPalettesLoading = true;
      try {
        const variants = await extractCustomPalettes(imageUrl);
        this.customPalettes = variants;
        if (this.customPaletteId && !variants.some((v) => v.id === this.customPaletteId)) {
          this.customPaletteId = variants[0]?.id ?? null;
        }
        if (selectDefault && variants[0]) {
          this.customPaletteId = variants[0].id;
          this.theme = "custom";
          this.applyAppearance();
          return;
        }
        if (this.theme === "custom") {
          this.applyAppearance();
        }
      } catch (error) {
        console.warn("[Settings] palette extraction failed:", error);
        this.customPalettes = [];
      } finally {
        this.customPalettesLoading = false;
      }
    },
    async load(projectRoot?: string) {
      const storedUi = readStoredUiSettings();
      if (storedUi?.theme) this.theme = normalizeThemeId(storedUi.theme);
      if (typeof storedUi?.maxInstances === "number") this.maxInstances = storedUi.maxInstances;
      if (storedUi?.locale) this.locale = storedUi.locale;
      if (typeof storedUi?.firstLaunchComplete === "boolean") {
        this.firstLaunchComplete = storedUi.firstLaunchComplete;
      }
      if (storedUi?.agentMode) {
        this.agentMode = storedUi.agentMode;
      }
      if (isWallpaperMode(storedUi?.wallpaperMode)) {
        this.wallpaperMode = storedUi.wallpaperMode;
      }
      if (typeof storedUi?.wallpaperOpacity === "number") {
        this.wallpaperOpacity = clampWallpaperOpacity(storedUi.wallpaperOpacity);
      }
      if (typeof storedUi?.wallpaperBlur === "number") {
        this.wallpaperBlur = clampWallpaperBlur(storedUi.wallpaperBlur);
      }
      if (isCustomPaletteId(storedUi?.customPaletteId)) {
        this.customPaletteId = storedUi.customPaletteId;
      } else if (storedUi?.customPaletteId === null) {
        this.customPaletteId = null;
      }
      this.wallpaperDataUrl = readStoredWallpaperDataUrl();
      // Follow-theme ignores stored clarity/blur and always uses theme defaults.
      this.syncThemeWallpaperDefaults();
      await this.refreshCustomPalettes();
      this.applyAppearance();

      const effective = await inspectLlmConfig(projectRoot, null, false);
      this.provider = providerFromEffective(effective);
      this.hasApiKey = effective.apiKeyAvailable;
      this.applyModelsRoutingFromEffective(effective);
      this.isLoaded = true;
    },
    setProviderId(id: LLMProviderId) {
      this.provider = providerDefaults(id);
      this.hasApiKey = false;
    },
    setProtocol(protocol: LLMProtocol) {
      this.provider.protocol = protocol;
    },
    setLocale(locale: AppLocale) {
      this.locale = locale;
    },
    /** Follow-theme mode uses theme defaults; clarity/blur are not user-tunable. */
    syncThemeWallpaperDefaults() {
      if (this.wallpaperMode !== "theme") return;
      this.wallpaperBlur = DEFAULT_WALLPAPER_BLUR;
      if (this.theme === "custom") {
        this.wallpaperOpacity = DEFAULT_WALLPAPER_OPACITY;
        return;
      }
      const builtin = themeDefaultWallpaper(resolveThemeId(this.theme));
      this.wallpaperOpacity = builtin?.defaultOpacity ?? DEFAULT_WALLPAPER_OPACITY;
    },
    setTheme(theme: AppThemeId) {
      const next = normalizeThemeId(theme);
      // Preset themes clear the custom palette selection.
      if (next !== "custom") {
        this.customPaletteId = null;
      }
      this.theme = next;
      this.syncThemeWallpaperDefaults();
      this.applyAppearance();
    },
    setCustomPalette(id: CustomPaletteId) {
      this.customPaletteId = id;
      this.theme = "custom";
      this.applyAppearance();
    },
    setWallpaperMode(mode: WallpaperMode) {
      this.wallpaperMode = mode;
      if (mode === "theme") {
        this.syncThemeWallpaperDefaults();
      } else if (isBuiltinWallpaperId(mode)) {
        this.wallpaperOpacity = BUILTIN_WALLPAPERS[mode].defaultOpacity;
      }
      this.applyAppearance();
      void this.refreshCustomPalettes();
    },
    setWallpaperOpacity(opacity: number) {
      this.wallpaperOpacity = clampWallpaperOpacity(opacity);
      this.applyAppearance();
    },
    setWallpaperBlur(blur: number) {
      this.wallpaperBlur = clampWallpaperBlur(blur);
      this.applyAppearance();
    },
    async setCustomWallpaper(file: File) {
      const dataUrl = await prepareWallpaperDataUrl(file);
      writeStoredWallpaperDataUrl(dataUrl);
      this.wallpaperDataUrl = dataUrl;
      this.wallpaperMode = "custom";
      this.applyAppearance();
      await this.refreshCustomPalettes(true);
    },
    clearCustomWallpaper() {
      writeStoredWallpaperDataUrl(null);
      this.wallpaperDataUrl = null;
      if (this.wallpaperMode === "custom") {
        this.wallpaperMode = "theme";
      }
      if (this.theme === "custom") {
        this.theme = "system";
        this.customPaletteId = null;
      }
      this.customPalettes = [];
      this.syncThemeWallpaperDefaults();
      this.applyAppearance();
      void this.refreshCustomPalettes();
    },
    setAgentMode(mode: AgentRunMode) {
      this.agentMode = mode;
    },
    selectModel(providerId: LLMProviderId, model: string) {
      if (this.provider.id !== providerId) {
        this.provider = providerDefaults(providerId);
      }
      this.provider.model = model;
    },
    applyProviderModel(params: {
      providerId: LLMProviderId;
      protocol?: LLMProtocol;
      apiBaseUrl: string;
      model: string;
    }) {
      this.provider = {
        id: params.providerId,
        protocol: params.protocol ?? this.provider.protocol,
        apiBaseUrl: params.apiBaseUrl,
        model: params.model,
        apiKeyRef: `llm:${params.providerId}:api-key`,
      };
    },
    /** Switch the settings editor to an existing Vera provider profile. */
    editCatalogProvider(provider: CatalogProvider) {
      this.provider = {
        id: provider.id,
        protocol: resolveCatalogProtocol(provider),
        apiBaseUrl: provider.apiBaseUrl ?? "",
        model: provider.model ?? "",
        apiKeyRef: `llm:${provider.id}:api-key`,
      };
      this.hasApiKey = provider.hasApiKey;
    },
    createProviderProfile(id: string, preset?: Partial<LLMProvider>) {
      const trimmed = id.trim().replace(/\s+/g, "-");
      if (!trimmed) return;
      const base = providerDefaults(trimmed);
      this.provider = {
        ...base,
        ...preset,
        id: trimmed,
        apiKeyRef: `llm:${trimmed}:api-key`,
      };
      this.hasApiKey = false;
    },
    async refreshApiKeyStatus() {
      const effective = await inspectLlmConfig(undefined, null, false);
      this.hasApiKey = effective.apiKeyAvailable;
    },
    persistUi() {
      window.localStorage.setItem(
        UI_SETTINGS_STORAGE_KEY,
        JSON.stringify({
          theme: this.theme,
          maxInstances: this.maxInstances,
          locale: this.locale,
          firstLaunchComplete: this.firstLaunchComplete,
          agentMode: this.agentMode,
          wallpaperMode: this.wallpaperMode,
          wallpaperOpacity: this.wallpaperOpacity,
          wallpaperBlur: this.wallpaperBlur,
          customPaletteId: this.customPaletteId,
        }),
      );
    },
    async saveLlm(
      projectRoot?: string,
      options?: { apiKey?: string; setAsDefault?: boolean },
    ) {
      const model =
        this.provider.model.trim() ||
        this.defaultModel.trim() ||
        this.modelAliases.find((item) => item.provider === this.provider.id)?.alias ||
        "";
      const effective = await saveVeraLlmConfig({
        projectRoot,
        provider: this.provider.id,
        protocol: this.provider.protocol,
        apiBaseUrl: this.provider.apiBaseUrl,
        model,
        ...(options?.apiKey !== undefined ? { apiKey: options.apiKey } : {}),
        ...(options?.setAsDefault !== undefined
          ? { setAsDefault: options.setAsDefault }
          : {}),
      });
      this.hasApiKey = effective.apiKeyAvailable;
      this.applyModelsRoutingFromEffective(effective);
      return effective;
    },
    async save(projectRoot?: string, options?: { setAsDefault?: boolean }) {
      this.persistUi();
      await this.saveLlm(projectRoot, { setAsDefault: options?.setAsDefault });
    },
    async saveApiKey(value: string, projectRoot?: string, setAsDefault = false) {
      const nextValue = value.trim();
      await this.saveLlm(projectRoot, { apiKey: nextValue, setAsDefault });
    },
    async renameProvider(oldId: string, newId: string, projectRoot?: string) {
      const effective = await renameVeraProvider({
        projectRoot,
        oldId,
        newId,
      });
      this.provider = {
        ...this.provider,
        id: newId.trim().replace(/\s+/g, "-"),
        apiKeyRef: `llm:${newId.trim().replace(/\s+/g, "-")}:api-key`,
      };
      this.hasApiKey = effective.apiKeyAvailable;
      this.applyModelsRoutingFromEffective(effective);
      return effective;
    },
    async saveModelsRouting(
      projectRoot?: string,
      snapshot?: Partial<VeraModelsRoutingSnapshot>,
    ) {
      const models = (snapshot?.models ?? this.modelAliases).map((item) => ({
        alias: item.alias,
        provider: item.provider,
        ...(item.model ? { model: item.model } : {}),
      }));
      const routing = snapshot?.routing ?? this.routing;
      const effective = await saveVeraModelsRouting({
        projectRoot,
        models,
        defaultProvider: snapshot?.defaultProvider ?? this.provider.id,
        defaultModel: snapshot?.defaultModel ?? this.defaultModel,
        routing: {
          enabled: Boolean(routing.enabled),
          ...(routing.classifier ? { classifier: String(routing.classifier) } : {}),
          ...(routing.l0 ? { l0: String(routing.l0) } : {}),
          ...(routing.l1 ? { l1: String(routing.l1) } : {}),
          ...(routing.l2 ? { l2: String(routing.l2) } : {}),
        },
      });
      this.applyModelsRoutingFromEffective(effective);
      return effective;
    },
    async runtimeLlmConfig(projectRoot?: string): Promise<LLMRuntimeConfig | null> {
      const effective = await inspectLlmConfig(projectRoot, null, true);
      if (!effective.apiKeyValue) return null;
      return {
        provider: this.provider.id,
        protocol: this.provider.protocol,
        apiBaseUrl: this.provider.apiBaseUrl || effective.apiBaseUrl,
        model: this.defaultModel || this.provider.model || effective.model,
        apiKey: effective.apiKeyValue,
      };
    },
  },
});
