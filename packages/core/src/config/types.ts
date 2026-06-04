export type AdapterType = "anthropic" | "openai" | "gemini";

export interface ProviderModelConfig {
  /** Optional protocol override for this model. Defaults to the provider adapter. */
  adapter?: AdapterType;
  /** Optional API key override for this model. Defaults to the provider API key/env. */
  api_key?: string;
  /** Optional endpoint override for this model. Defaults to the provider base_url. */
  base_url?: string;
}

export interface ModelConfig extends ProviderModelConfig {
  /** Provider entry to inherit adapter/api_key/base_url from. */
  provider: string;
  /** Concrete upstream model id sent to the provider adapter. Defaults to the alias key. */
  model?: string;
}

export type ModelReference = string | RoutingTarget;

export interface ProviderConfig {
  adapter: AdapterType;
  api_key?: string;
  base_url?: string;
}

export interface RoutingTarget {
  provider: string;
  model: string;
}

export interface RoutingConfig {
  enabled?: boolean;
  classifier?: ModelReference; // 用哪个模型跑分类器
  l0?: ModelReference;
  l1?: ModelReference;
  l2?: ModelReference;
}

export interface SessionConfig {
  ai_title?: {
    enabled?: boolean;
    provider?: string;
    model?: string;
  };
  compact?: {
    enabled?: boolean;
    provider?: string;
    model?: string;
  };
}

export interface MCPServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface VeraConfig {
  providers?: Record<string, ProviderConfig>;
  /**
   * Available model instances.
   * - Array form: ["model-id"] uses the only/default provider and model-id as upstream id.
   * - Object form: aliases can freely combine provider/model/adapter.
   */
  models?: string[] | Record<string, ModelConfig>;
  default_provider?: string;
  /** Model alias from models, or a concrete provider model id when default_provider is set. */
  default_model?: string;
  routing?: RoutingConfig;
  session?: SessionConfig;
  mcp_servers?: Record<string, MCPServerConfig>;
}
