import { EventBus, type RuntimeCapabilityRegistry } from "@open-vera/plugin-runtime";
import type { VeraConfig } from "../config/types.js";
import {
  resolveDefaultTarget,
  resolveProviderModelConfig,
} from "../config/model-tiers.js";
import type {
  CompletionRequest,
  CompletionResponse,
  StreamEvent,
} from "../types/index.js";
import type { ModelInfo } from "../types/model.js";
import { AnthropicAdapter } from "./anthropic.js";
import type { LLMAdapter } from "./base.js";
import { normalizeBaseUrlForAdapter } from "./base-url.js";
import { GeminiAdapter } from "./gemini.js";
import { OpenAIAdapter } from "./openai.js";
import { OpenAIResponsesAdapter } from "./openai-responses.js";

export type LlmPurpose = "chat" | "routing" | "compression" | "vision" | "tool";

export interface LlmSelection {
  adapter: LLMAdapter;
  model: string;
  provider: string;
  adapterType: string;
}

export interface LlmAdapterFactoryOptions {
  adapterType: string;
  provider: string;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  purpose: LlmPurpose;
}

export type LlmAdapterFactory = (options: LlmAdapterFactoryOptions) => LLMAdapter;

export interface LlmServiceOptions {
  config: VeraConfig;
  eventBus?: EventBus;
  apiKeyOverride?: string;
  capabilities?: RuntimeCapabilityRegistry;
  adapterFactories?: Record<string, LlmAdapterFactory>;
}

export interface LlmRequestOptions {
  provider?: string;
  model?: string;
  purpose?: LlmPurpose;
}

export interface BuildLlmAdapterOptions extends LlmRequestOptions {}

export class LlmService {
  readonly eventBus: EventBus;
  private readonly config: VeraConfig;
  private readonly apiKeyOverride?: string;
  private readonly capabilities?: RuntimeCapabilityRegistry;
  private readonly adapterFactories = new Map<string, LlmAdapterFactory>();

  constructor(options: LlmServiceOptions) {
    this.config = options.config;
    this.eventBus = options.eventBus ?? new EventBus();
    this.apiKeyOverride = options.apiKeyOverride;
    this.capabilities = options.capabilities;
    for (const [name, factory] of Object.entries(options.adapterFactories ?? {})) {
      this.registerAdapterFactory(name, factory);
    }
  }

  registerAdapterFactory(name: string, factory: LlmAdapterFactory): void {
    this.adapterFactories.set(name, factory);
  }

  resolveModel(options: LlmRequestOptions = {}): { provider: string; model: string } {
    const target = options.provider && options.model
      ? { provider: options.provider, model: options.model }
      : resolveDefaultTarget(this.config);
    return {
      provider: options.provider ?? target.provider,
      model: options.model ?? target.model,
    };
  }

  selectAdapter(options: LlmRequestOptions = {}): LlmSelection {
    const target = this.resolveModel(options);
    const pc = resolveProviderModelConfig(this.config, target);
    const apiKey = this.apiKeyOverride ?? pc.api_key ?? resolveEnvKey(pc.adapter, target.provider);
    const purpose = options.purpose ?? "chat";
    const adapter = this.buildConfiguredAdapter({
      adapterType: pc.adapter,
      provider: target.provider,
      model: target.model,
      ...(apiKey ? { apiKey } : {}),
      ...(pc.base_url ? { baseUrl: pc.base_url } : {}),
      ...(pc.headers ? { headers: pc.headers } : {}),
      purpose,
    });
    return {
      adapter,
      model: target.model,
      provider: target.provider,
      adapterType: pc.adapter,
    };
  }

  async complete(
    request: CompletionRequest,
    options: LlmRequestOptions = {},
  ): Promise<CompletionResponse> {
    const selected = this.selectAdapter({ ...options, model: options.model ?? request.model });
    const nextRequest = await this.eventBus.emitTransform<CompletionRequest>(
      "llm:request",
      { ...request, model: selected.model },
      eventContext(selected, options.purpose ?? "chat"),
    );
    try {
      const response = await selected.adapter.complete(nextRequest);
      await this.eventBus.emitObserve(
        "llm:response",
        summarizeResponse(response, selected, options.purpose ?? "chat"),
        eventContext(selected, options.purpose ?? "chat"),
      );
      return response;
    } catch (error) {
      await this.eventBus.emitObserve(
        "llm:error",
        {
          provider: selected.provider,
          adapterType: selected.adapterType,
          model: selected.model,
          purpose: options.purpose ?? "chat",
          error: error instanceof Error ? error.message : String(error),
        },
        eventContext(selected, options.purpose ?? "chat"),
      );
      throw error;
    }
  }

  async *stream(
    request: CompletionRequest,
    options: LlmRequestOptions = {},
  ): AsyncIterable<StreamEvent> {
    const selected = this.selectAdapter({ ...options, model: options.model ?? request.model });
    const nextRequest = await this.eventBus.emitTransform<CompletionRequest>(
      "llm:request",
      { ...request, model: selected.model },
      eventContext(selected, options.purpose ?? "chat"),
    );
    try {
      for await (const event of selected.adapter.stream(nextRequest)) {
        yield event;
      }
      await this.eventBus.emitObserve(
        "llm:response",
        {
          provider: selected.provider,
          adapterType: selected.adapterType,
          model: selected.model,
          purpose: options.purpose ?? "chat",
          streamed: true,
        },
        eventContext(selected, options.purpose ?? "chat"),
      );
    } catch (error) {
      await this.eventBus.emitObserve(
        "llm:error",
        {
          provider: selected.provider,
          adapterType: selected.adapterType,
          model: selected.model,
          purpose: options.purpose ?? "chat",
          error: error instanceof Error ? error.message : String(error),
        },
        eventContext(selected, options.purpose ?? "chat"),
      );
      throw error;
    }
  }

  async listModels(provider?: string): Promise<ModelInfo[]> {
    const selected = this.selectAdapter(provider ? { provider } : {});
    return selected.adapter.listModels?.() ?? [];
  }

  buildAdapter(provider?: string, model?: string, options: Omit<BuildLlmAdapterOptions, "provider" | "model"> = {}): LLMAdapter {
    const requestOptions: LlmRequestOptions = {
      provider,
      model,
      purpose: options.purpose ?? "chat",
    };
    return {
      complete: (request) => this.complete(request, requestOptions),
      stream: (request) => this.stream(request, requestOptions),
      listModels: () => this.listModels(provider),
    };
  }

  private buildConfiguredAdapter(options: LlmAdapterFactoryOptions): LLMAdapter {
    const factory = this.resolveAdapterFactory(options.adapterType);
    if (!factory) {
      throw new UnknownLlmAdapterError(options.adapterType, options.provider);
    }
    const baseUrl = normalizeBaseUrlForAdapter(options.adapterType, options.baseUrl);
    return factory({
      ...options,
      ...(baseUrl ? { baseUrl } : {}),
    });
  }

  private resolveAdapterFactory(adapterType: string): LlmAdapterFactory | undefined {
    return this.adapterFactories.get(adapterType)
      ?? factoryFromRuntimeCapability(this.capabilities, adapterType)
      ?? builtinAdapterFactories[adapterType];
  }
}

export function resolveEnvKey(adapter: string, name: string): string | undefined {
  const providerKey = process.env[`${name.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_API_KEY`];
  if (providerKey) return providerKey;
  switch (adapter) {
    case "openai":
    case "openai-responses":
      return process.env.OPENAI_API_KEY;
    case "gemini":
      return process.env.GEMINI_API_KEY;
    default:
      return process.env.ANTHROPIC_API_KEY;
  }
}

export function envVarFor(adapter: string, provider?: string): string {
  if (provider) return `${provider.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_API_KEY`;
  switch (adapter) {
    case "openai":
    case "openai-responses":
      return "OPENAI_API_KEY";
    case "gemini":
      return "GEMINI_API_KEY";
    default:
      return "ANTHROPIC_API_KEY";
  }
}

export class UnknownLlmAdapterError extends Error {
  constructor(adapterType: string, provider: string) {
    super(`No LLM adapter registered for adapter "${adapterType}" used by provider "${provider}"`);
    this.name = "UnknownLlmAdapterError";
  }
}

const builtinAdapterFactories: Record<string, LlmAdapterFactory> = {
  openai: ({ apiKey, baseUrl, headers }) => new OpenAIAdapter(apiKey, baseUrl, headers),
  "openai-responses": ({ apiKey, baseUrl, headers }) =>
    new OpenAIResponsesAdapter(apiKey, baseUrl, headers),
  gemini: ({ apiKey }) => new GeminiAdapter(apiKey),
  anthropic: ({ apiKey, baseUrl, headers }) => new AnthropicAdapter(apiKey, baseUrl, headers),
};

function factoryFromRuntimeCapability(
  capabilities: RuntimeCapabilityRegistry | undefined,
  adapterType: string,
): LlmAdapterFactory | undefined {
  const capability = capabilities?.get(adapterType);
  if (!capability || capability.kind !== "llm-adapter" || capability.status !== "available") {
    return undefined;
  }
  if (typeof capability.factory !== "function") {
    return undefined;
  }
  return capability.factory as LlmAdapterFactory;
}

function eventContext(selected: LlmSelection, purpose: LlmPurpose) {
  return {
    pluginId: "llm-service",
    metadata: {
      provider: selected.provider,
      adapterType: selected.adapterType,
      model: selected.model,
      purpose,
    },
  };
}

function summarizeResponse(
  response: CompletionResponse,
  selected: LlmSelection,
  purpose: LlmPurpose,
): Record<string, unknown> {
  return {
    provider: selected.provider,
    adapterType: selected.adapterType,
    model: selected.model,
    purpose,
    usage: response.usage,
    contentLength: messageContentLength(response.message.content),
  };
}

function messageContentLength(content: CompletionResponse["message"]["content"]): number {
  if (typeof content === "string") return content.length;
  return content.reduce((total, part) => {
    if (part.type === "text") return total + part.text.length;
    return total;
  }, 0);
}
