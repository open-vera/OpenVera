import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSettingsStore } from "@/stores/settings";

const localValues = new Map<string, string>();
const inspectLlmConfigMock = vi.fn();
const saveVeraLlmConfigMock = vi.fn();

interface SaveVeraLlmConfigParams {
  projectRoot?: string;
  provider: string;
  protocol: string;
  apiBaseUrl: string;
  model: string;
  apiKey?: string;
}

vi.mock("@/bridge", () => ({
  inspectLlmConfig: (...args: unknown[]) => inspectLlmConfigMock(...args),
  saveVeraLlmConfig: (...args: unknown[]) => saveVeraLlmConfigMock(...args),
}));

describe("useSettingsStore", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    localValues.clear();
    inspectLlmConfigMock.mockReset();
    saveVeraLlmConfigMock.mockReset();
    inspectLlmConfigMock.mockResolvedValue({
      source: "vera-config",
      sourceLabel: "Vera config",
      projectRoot: "/repo",
      provider: "anthropic",
      adapter: "anthropic",
      protocol: "anthropic",
      model: "claude-sonnet",
      apiBaseUrl: "https://api.anthropic.com",
      apiKeyAvailable: false,
      apiKeySource: "missing",
      apiKeySourceLabel: "Not found",
      configExists: true,
    });
    saveVeraLlmConfigMock.mockImplementation(async (params: SaveVeraLlmConfigParams) => ({
      source: "vera-config",
      sourceLabel: "Vera config",
      projectRoot: params.projectRoot ?? "/repo",
      provider: params.provider,
      adapter: params.protocol === "openai-compatible" ? "openai" : params.protocol,
      protocol: params.protocol,
      model: params.model,
      apiBaseUrl: params.apiBaseUrl,
      apiKeyAvailable: Boolean(params.apiKey),
      apiKeySource: params.apiKey ? "vera-config" : "missing",
      apiKeySourceLabel: params.apiKey ? "Vera config api_key" : "Not found",
      configExists: true,
    }));
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => localValues.get(key) ?? null,
        setItem: (key: string, value: string) => {
          localValues.set(key, value);
        },
        removeItem: (key: string) => {
          localValues.delete(key);
        },
      },
    });
  });

  it("persists model configuration to Vera settings", async () => {
    const settings = useSettingsStore();
    settings.provider.apiBaseUrl = "https://api.example.com/v1";
    settings.provider.model = "claude-test";

    await settings.save("/repo");

    expect(saveVeraLlmConfigMock).toHaveBeenCalledWith({
      projectRoot: "/repo",
      provider: "anthropic",
      protocol: "anthropic",
      apiBaseUrl: "https://api.example.com/v1",
      model: "claude-test",
    });
  });

  it("does not overwrite editable provider fields with effective config after save", async () => {
    saveVeraLlmConfigMock.mockResolvedValueOnce({
      source: "vera-config",
      sourceLabel: "Vera config",
      projectRoot: "/repo",
      provider: "effective-provider",
      adapter: "anthropic",
      protocol: "anthropic",
      model: "effective-model",
      apiBaseUrl: "https://effective.example.com",
      apiKeyAvailable: true,
      apiKeySource: "vera-config",
      apiKeySourceLabel: "Vera config api_key",
      configExists: true,
    });
    const settings = useSettingsStore();
    settings.provider.id = "company";
    settings.provider.apiBaseUrl = "https://gateway.example.com";
    settings.provider.model = "claude-sonnet-4-6";

    await settings.save("/repo");

    expect(settings.provider.id).toBe("company");
    expect(settings.provider.apiBaseUrl).toBe("https://gateway.example.com");
    expect(settings.provider.model).toBe("claude-sonnet-4-6");
    expect(settings.hasApiKey).toBe(true);
  });

  it("stores and clears API keys in Vera settings", async () => {
    const settings = useSettingsStore();

    await settings.saveApiKey("secret-key", "/repo");
    expect(settings.hasApiKey).toBe(true);
    expect(saveVeraLlmConfigMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ apiKey: "secret-key", projectRoot: "/repo" }),
    );

    await settings.saveApiKey("", "/repo");
    expect(settings.hasApiKey).toBe(false);
    expect(saveVeraLlmConfigMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ apiKey: "", projectRoot: "/repo" }),
    );
  });

  it("persists locale preference", async () => {
    const settings = useSettingsStore();

    settings.setLocale("en");
    await settings.save();

    expect(localValues.get("partner:ui-settings")).toContain('"locale":"en"');
  });

  it("persists agent mode preference", async () => {
    const settings = useSettingsStore();

    settings.setAgentMode("plan");
    await settings.save();

    expect(localValues.get("partner:ui-settings")).toContain('"agentMode":"plan"');
  });

  it("builds runtime llm config from effective secrets", async () => {
    inspectLlmConfigMock.mockResolvedValueOnce({
      source: "vera-config",
      sourceLabel: "Vera config",
      projectRoot: "/repo",
      provider: "anthropic",
      adapter: "anthropic",
      protocol: "anthropic",
      model: "claude-sonnet",
      apiBaseUrl: "https://api.anthropic.com",
      apiKeyAvailable: true,
      apiKeySource: "vera-config",
      apiKeySourceLabel: "Vera config api_key",
      apiKeyValue: "secret-key",
      configExists: true,
    });
    const settings = useSettingsStore();
    settings.provider.model = "claude-opus-4-6";

    const runtime = await settings.runtimeLlmConfig("/repo");

    expect(runtime).toEqual({
      provider: "anthropic",
      protocol: "anthropic",
      apiBaseUrl: "https://api.anthropic.com",
      model: "claude-opus-4-6",
      apiKey: "secret-key",
    });
  });

  it("switches provider and model together", () => {
    const settings = useSettingsStore();

    settings.selectModel("openai", "gpt-4o");

    expect(settings.provider.id).toBe("openai");
    expect(settings.provider.model).toBe("gpt-4o");
    expect(settings.provider.protocol).toBe("openai-compatible");
  });

  it("applies provider model from catalog selection", () => {
    const settings = useSettingsStore();

    settings.applyProviderModel({
      providerId: "compony",
      protocol: "anthropic",
      apiBaseUrl: "https://gateway.example.com",
      model: "deepseek-v4-pro",
    });

    expect(settings.provider).toMatchObject({
      id: "compony",
      protocol: "anthropic",
      apiBaseUrl: "https://gateway.example.com",
      model: "deepseek-v4-pro",
    });
  });

  it("keeps the current protocol when applyProviderModel omits it", () => {
    const settings = useSettingsStore();
    settings.provider.protocol = "openai-compatible";

    settings.applyProviderModel({
      providerId: "compony",
      apiBaseUrl: "https://gateway.example.com",
      model: "deepseek-v4-flash",
    });

    expect(settings.provider.protocol).toBe("openai-compatible");
    expect(settings.provider.model).toBe("deepseek-v4-flash");
  });
});
