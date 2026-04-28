export type AdapterType = "anthropic" | "openai" | "gemini";

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
  classifier?: RoutingTarget; // 用哪个 provider+model 跑分类器
  l0?: RoutingTarget;
  l1?: RoutingTarget;
  l2?: RoutingTarget;
  l3?: RoutingTarget;
}

export interface MCPServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface VeraConfig {
  providers?: Record<string, ProviderConfig>;
  default_provider?: string;
  default_model?: string;
  routing?: RoutingConfig;
  mcp_servers?: Record<string, MCPServerConfig>;
}
