import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useModelCatalogStore } from "@/stores/model-catalog";

const listLlmProvidersMock = vi.fn();
const listLlmProviderModelsMock = vi.fn();
const refreshLlmProviderModelsMock = vi.fn();

vi.mock("@/bridge/llm-catalog", () => ({
  listLlmProviders: (...args: unknown[]) => listLlmProvidersMock(...args),
  listLlmProviderModels: (...args: unknown[]) => listLlmProviderModelsMock(...args),
  refreshLlmProviderModels: (...args: unknown[]) => refreshLlmProviderModelsMock(...args),
}));

describe("useModelCatalogStore", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    listLlmProvidersMock.mockReset();
    listLlmProviderModelsMock.mockReset();
    refreshLlmProviderModelsMock.mockReset();
    listLlmProvidersMock.mockResolvedValue([
      {
        id: "compony",
        adapter: "anthropic",
        protocol: "anthropic",
        apiBaseUrl: "https://gateway.example.com",
        hasApiKey: true,
        isDefault: true,
      },
    ]);
    listLlmProviderModelsMock.mockResolvedValue([
      { id: "deepseek-v4-flash", displayName: "deepseek-v4-flash", source: "config" },
      { id: "deepseek-v4-pro", displayName: "deepseek-v4-pro", source: "config" },
    ]);
    refreshLlmProviderModelsMock.mockResolvedValue([
      { id: "remote-model", displayName: "Remote Model" },
    ]);
  });

  it("loads providers once per project root", async () => {
    const catalog = useModelCatalogStore();

    await catalog.loadProviders("/repo");
    await catalog.loadProviders("/repo");

    expect(listLlmProvidersMock).toHaveBeenCalledTimes(1);
    expect(catalog.availableProviders).toHaveLength(1);
  });

  it("shows configured models immediately and merges remote models later", async () => {
    const catalog = useModelCatalogStore();
    await catalog.loadProviders("/repo");

    await catalog.ensureProviderModels("/repo", "compony");
    expect(listLlmProviderModelsMock).toHaveBeenCalledTimes(1);
    expect(catalog.modelsForProvider("compony").length).toBeGreaterThanOrEqual(2);

    await vi.waitFor(() => {
      expect(refreshLlmProviderModelsMock).toHaveBeenCalledTimes(1);
    });
    await vi.waitFor(() => {
      expect(catalog.modelsForProvider("compony").some((model) => model.id === "remote-model")).toBe(
        true,
      );
    });
  });

  it("does not refresh remote models again within ttl", async () => {
    const catalog = useModelCatalogStore();
    await catalog.loadProviders("/repo");
    await catalog.ensureProviderModels("/repo", "compony");
    await vi.waitFor(() => {
      expect(refreshLlmProviderModelsMock).toHaveBeenCalledTimes(1);
    });

    await catalog.ensureProviderModels("/repo", "compony");

    expect(refreshLlmProviderModelsMock).toHaveBeenCalledTimes(1);
  });

  it("times out remote refresh without leaving provider stuck", async () => {
    vi.useFakeTimers();
    refreshLlmProviderModelsMock.mockImplementation(
      () => new Promise(() => {
        /* never resolves */
      }),
    );
    const catalog = useModelCatalogStore();
    await catalog.loadProviders("/repo");
    listLlmProviderModelsMock.mockResolvedValueOnce([]);

    const pending = catalog.refreshProviderModels("/repo", "compony", { force: true });
    await vi.advanceTimersByTimeAsync(12_000);
    await pending;

    expect(catalog.isProviderRefreshing("compony")).toBe(false);
    vi.useRealTimers();
  });
});
