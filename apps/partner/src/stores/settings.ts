import { defineStore } from "pinia";
import {
  inspectLlmConfig,
  saveVeraLlmConfig,
} from "@/bridge";
import type {
  AppLocale,
  EffectiveLlmConfig,
  LLMProvider,
  LLMProviderId,
  LLMProtocol,
  LLMRuntimeConfig,
} from "@/types";

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
  theme?: "dark" | "light" | "system";
  maxInstances?: number;
  locale?: AppLocale;
  firstLaunchComplete?: boolean;
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
    theme: "system" as "dark" | "light" | "system",
    maxInstances: 3,
    locale: "zh" as AppLocale,
    firstLaunchComplete: false,
    hasApiKey: false,
    isLoaded: false,
  }),
  actions: {
    async load(projectRoot?: string) {
      const storedUi = readStoredUiSettings();
      if (storedUi?.theme) this.theme = storedUi.theme;
      if (typeof storedUi?.maxInstances === "number") this.maxInstances = storedUi.maxInstances;
      if (storedUi?.locale) this.locale = storedUi.locale;
      if (typeof storedUi?.firstLaunchComplete === "boolean") {
        this.firstLaunchComplete = storedUi.firstLaunchComplete;
      }

      const effective = await inspectLlmConfig(projectRoot, null, false);
      this.provider = providerFromEffective(effective);
      this.hasApiKey = effective.apiKeyAvailable;
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
    async refreshApiKeyStatus() {
      const effective = await inspectLlmConfig(undefined, null, false);
      this.hasApiKey = effective.apiKeyAvailable;
    },
    async save(projectRoot?: string) {
      window.localStorage.setItem(
        UI_SETTINGS_STORAGE_KEY,
        JSON.stringify({
          theme: this.theme,
          maxInstances: this.maxInstances,
          locale: this.locale,
          firstLaunchComplete: this.firstLaunchComplete,
        }),
      );
      const effective = await saveVeraLlmConfig({
        projectRoot,
        provider: this.provider.id,
        protocol: this.provider.protocol,
        apiBaseUrl: this.provider.apiBaseUrl,
        model: this.provider.model,
      });
      this.hasApiKey = effective.apiKeyAvailable;
    },
    async saveApiKey(value: string, projectRoot?: string) {
      const nextValue = value.trim();
      const effective = await saveVeraLlmConfig({
        projectRoot,
        provider: this.provider.id,
        protocol: this.provider.protocol,
        apiBaseUrl: this.provider.apiBaseUrl,
        model: this.provider.model,
        apiKey: nextValue,
      });
      this.hasApiKey = effective.apiKeyAvailable;
    },
    async runtimeLlmConfig(): Promise<LLMRuntimeConfig | null> {
      return null;
    },
  },
});
