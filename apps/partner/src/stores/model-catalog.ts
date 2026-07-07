import { defineStore } from "pinia";
import {
  listLlmProviderModels,
  listLlmProviders,
  refreshLlmProviderModels,
} from "@/bridge/llm-catalog";
import type { CatalogModel, CatalogProvider, LLMProtocol } from "@/types";

const REMOTE_REFRESH_TTL_MS = 5 * 60 * 1000;
const REMOTE_REFRESH_FAILED_TTL_MS = 2 * 60 * 1000;
const REMOTE_REFRESH_TIMEOUT_MS = 12_000;

interface RemoteRefreshState {
  at: number;
  failed?: boolean;
}

function mergeModels(configured: CatalogModel[], remote: CatalogModel[]): CatalogModel[] {
  if (!remote.length) return configured;
  const seen = new Set(remote.map((model) => model.id));
  const extras = configured.filter((model) => !seen.has(model.id));
  return [...remote, ...extras];
}

function shouldRefreshRemote(state?: RemoteRefreshState): boolean {
  if (!state) return true;
  const ttl = state.failed ? REMOTE_REFRESH_FAILED_TTL_MS : REMOTE_REFRESH_TTL_MS;
  return Date.now() - state.at >= ttl;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = globalThis.setTimeout(() => {
      reject(new Error(message));
    }, timeoutMs);
    void promise.then(
      (value) => {
        globalThis.clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        globalThis.clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

export const useModelCatalogStore = defineStore("modelCatalog", {
  state: () => ({
    providers: [] as CatalogProvider[],
    modelsByProvider: {} as Record<string, CatalogModel[]>,
    loadingProviders: false,
    loadingProviderIds: [] as string[],
    refreshingProviderIds: [] as string[],
    remoteRefreshState: {} as Record<string, RemoteRefreshState>,
    providerErrors: {} as Record<string, string>,
    providersError: "",
    loadedProjectRoot: "",
  }),
  getters: {
    availableProviders(state): CatalogProvider[] {
      return state.providers.filter((provider) => provider.hasApiKey);
    },
    isProviderLoading: (state) => (providerId: string) =>
      state.loadingProviderIds.includes(providerId),
    isProviderRefreshing: (state) => (providerId: string) =>
      state.refreshingProviderIds.includes(providerId),
    modelsForProvider: (state) => (providerId: string) =>
      state.modelsByProvider[providerId] ?? [],
  },
  actions: {
    async loadProviders(projectRoot?: string, force = false) {
      const root = projectRoot ?? "";
      if (!force && this.loadedProjectRoot === root && this.providers.length > 0) {
        return;
      }
      this.loadingProviders = true;
      this.providersError = "";
      try {
        this.providers = await listLlmProviders(root || undefined);
        this.loadedProjectRoot = root;
      } catch (error) {
        this.providers = [];
        this.providersError =
          error instanceof Error ? error.message : "加载模型供应商失败";
      } finally {
        this.loadingProviders = false;
      }
    },
    async ensureProviderModels(
      projectRoot: string | undefined,
      providerId: string,
      options?: { protocol?: string; force?: boolean },
    ) {
      if (options?.force) {
        this.invalidateProvider(providerId);
      }
      if (this.loadingProviderIds.includes(providerId)) return;

      if (!this.modelsByProvider[providerId]?.length) {
        this.loadingProviderIds.push(providerId);
        delete this.providerErrors[providerId];
        try {
          this.modelsByProvider[providerId] = await listLlmProviderModels(
            projectRoot,
            providerId,
          );
        } catch (error) {
          this.providerErrors[providerId] =
            error instanceof Error ? error.message : "加载模型列表失败";
          this.modelsByProvider[providerId] = [];
        } finally {
          this.loadingProviderIds = this.loadingProviderIds.filter((id) => id !== providerId);
        }
      }

      void this.refreshProviderModels(projectRoot, providerId, {
        protocol: options?.protocol,
        force: options?.force,
      });
    },
    async refreshProviderModels(
      projectRoot: string | undefined,
      providerId: string,
      options?: { protocol?: string; force?: boolean },
    ) {
      if (!options?.force && !shouldRefreshRemote(this.remoteRefreshState[providerId])) {
        return;
      }
      if (this.refreshingProviderIds.includes(providerId)) return;

      this.refreshingProviderIds.push(providerId);
      try {
        const remote = await withTimeout(
          refreshLlmProviderModels(projectRoot, providerId, {
            protocol: options?.protocol as LLMProtocol | undefined,
          }),
          REMOTE_REFRESH_TIMEOUT_MS,
          "同步远程模型超时",
        );
        if (remote.length) {
          const configured = this.modelsByProvider[providerId] ?? [];
          this.modelsByProvider[providerId] = mergeModels(configured, remote);
        }
        this.remoteRefreshState[providerId] = { at: Date.now() };
      } catch {
        this.remoteRefreshState[providerId] = { at: Date.now(), failed: true };
      } finally {
        this.refreshingProviderIds = this.refreshingProviderIds.filter(
          (id) => id !== providerId,
        );
      }
    },
    invalidateProvider(providerId: string) {
      delete this.modelsByProvider[providerId];
      delete this.remoteRefreshState[providerId];
      delete this.providerErrors[providerId];
      this.loadingProviderIds = this.loadingProviderIds.filter((id) => id !== providerId);
      this.refreshingProviderIds = this.refreshingProviderIds.filter((id) => id !== providerId);
    },
    reset() {
      this.providers = [];
      this.modelsByProvider = {};
      this.loadingProviderIds = [];
      this.refreshingProviderIds = [];
      this.remoteRefreshState = {};
      this.providerErrors = {};
      this.providersError = "";
      this.loadedProjectRoot = "";
    },
  },
});
