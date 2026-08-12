export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolApprovalRequest {
  callId: string;
  name: string;
  input: Record<string, unknown>;
  reason: string;
  cmd?: string;
  args?: string[];
  cwd?: string;
  allowDir?: string;
}

export interface FileChange {
  path: string;
  added: number;
  removed: number;
  unifiedDiff: string;
}

export interface ToolResult {
  id: string;
  output: string;
  isError?: boolean;
  /** Present when write_file / edit_file produced a structured diff. */
  fileChange?: FileChange;
}

export interface ChatErrorNotice {
  id: string;
  message: string;
  timestamp: number;
}

export type ChatAttachmentKind =
  | "text"
  | "image"
  | "binary"
  /** Workspace / Finder path reference (contents not inlined). */
  | "path"
  /** Directory path reference. */
  | "folder"
  /** Editor text selection — chip in UI, full content sent to the model. */
  | "selection";

export interface ChatAttachment {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  kind: ChatAttachmentKind;
  content?: string;
  dataUrl?: string;
  truncated?: boolean;
  /** Absolute filesystem path for path / folder / selection refs. */
  path?: string;
  /** 1-based line range for selection refs. */
  startLine?: number;
  endLine?: number;
}

export interface Message {
  id: string;
  role: "user" | "assistant" | "tool";
  content: string;
  agentContent?: string;
  timestamp: number;
  attachments?: ChatAttachment[];
  toolCalls?: ToolCall[];
  toolResults?: ToolResult[];
  isStreaming?: boolean;
  isError?: boolean;
  tokenCount?: number;
  queueStatus?: "queued" | "next";
  /**
   * Groups every message produced by one agent run. A run is split into
   * time-ordered segments (text → tools → text …) so the transcript keeps the
   * real order instead of "all tools, then all text". Absent on legacy sessions.
   */
  turnId?: string;
  /** Segment / turn end time, set when the segment stops accepting events. */
  endedAt?: number;
  /** Final usage for this tool segment, retained after the live run ends. */
  usage?: TokenUsage;
}

export interface ChatTab {
  id: string;
  title: string;
  kind: "chat" | "settings";
  messages: Message[];
  isAgentRunning: boolean;
  activeTaskId?: string | null;
  lastTaskId?: string | null;
  lastError?: ChatErrorNotice | null;
  currentTokenCount: number;
  estimatedCost: number;
  /** Latest agent-run usage / context-window stats for the active tab. */
  runUsage?: TokenUsage | null;
}

export interface Session {
  id: string;
  windowId: string;
  createdAt: number;
  lastActiveAt: number;
  instanceId: string | null;
}

export interface LayoutSnapshot {
  leftWidth: number;
  previewWidth: number;
  /** Session sidebar open */
  leftOpen?: boolean;
  /** Right workspace (explorer + editor) open */
  previewOpen?: boolean;
  /** File explorer open inside preview */
  explorerOpen?: boolean;
  /** Code editor open inside preview */
  editorOpen?: boolean;
  /** Bottom terminal panel open */
  terminalOpen?: boolean;
  /** Bottom terminal panel height in px */
  terminalHeight?: number;
}

export type LLMProviderId = string;
export type LLMProtocol =
  | "anthropic"
  | "openai-compatible"
  | "openai-responses"
  | "gemini";
export type AppLocale = "zh" | "en";
export type AgentRunMode = "agent" | "chat" | "plan";
export type { AppThemeId, ResolvedThemeId } from "@/theme";

export interface CatalogProvider {
  id: string;
  adapter: string;
  protocol: string;
  apiBaseUrl: string;
  hasApiKey: boolean;
  isDefault: boolean;
  /** Preferred / known model id for this provider (from settings). */
  model?: string;
}

export interface CatalogModel {
  id: string;
  displayName?: string;
  upstreamId?: string;
  source?: "config" | "remote";
}

export interface LLMProvider {
  id: LLMProviderId;
  protocol: LLMProtocol;
  apiBaseUrl: string;
  model: string;
  apiKeyRef: string;
}

export interface LLMRuntimeConfig {
  provider: LLMProviderId;
  protocol: LLMProtocol;
  apiBaseUrl: string;
  model: string;
  apiKey: string;
}

export interface VeraModelAlias {
  alias: string;
  provider: string;
  model?: string | null;
}

export interface VeraRoutingSettings {
  enabled: boolean;
  classifier?: string | null;
  l0?: string | null;
  l1?: string | null;
  l2?: string | null;
}

export interface EffectiveLlmConfig {
  source: "partner-settings" | "vera-config" | "environment" | "missing";
  sourceLabel: string;
  projectRoot: string;
  provider: string;
  adapter: string;
  protocol: string;
  model: string;
  apiBaseUrl: string;
  apiKeyAvailable: boolean;
  apiKeySource: "partner-keychain" | "vera-config" | "environment" | "missing";
  apiKeySourceLabel: string;
  apiKeyValue?: string;
  envKeyName?: string;
  configPath?: string | null;
  configScope?: "explicit" | "env" | "project" | "global" | string;
  configExists: boolean;
  projectConfigPath?: string | null;
  globalConfigPath?: string | null;
  defaultProvider?: string | null;
  defaultModel?: string | null;
  models?: VeraModelAlias[];
  routing?: VeraRoutingSettings;
}

export interface TaskStep {
  id: string;
  title: string;
  status: "pending" | "running" | "done" | "failed";
}

export interface Task {
  id: string;
  title: string;
  text?: string;
  attachments?: ChatAttachment[];
  chatTabId?: string;
  projectRoot?: string;
  steps: TaskStep[];
  createdAt: number;
}

export interface AgentInstance {
  id: string;
  status: "idle" | "running" | "error";
  sessionId: string;
}

export interface GatewayStatus {
  activeInstances: number;
  maxInstances: number;
  isHealthy: boolean;
}

export interface DirEntry {
  name: string;
  isDir: boolean;
}

export interface FileSearchEntry {
  name: string;
  path: string;
  isDir: boolean;
}

export interface FileContentSearchEntry {
  name: string;
  path: string;
  lineNumber: number;
  line: string;
}

export interface LspSymbolSearchEntry {
  name: string;
  kind: string;
  path: string;
}

export interface GitChange {
  path: string;
  status: string;
}

export interface ShellOutput {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface TokenUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  input?: number;
  output?: number;
  total?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  reasoning_tokens?: number;
  /** OpenAI/DeepSeek: cache_* already counted inside input_tokens. */
  cache_included_in_input?: boolean;
  /** Latest prompt size (approx) occupying the context window. */
  context_used?: number;
  /** Model context window limit. */
  context_max?: number;
  /** Latest-call breakdown (sums to context_used). */
  context_cache_read_tokens?: number;
  context_cache_write_tokens?: number;
  context_prompt_tokens?: number;
  duration_ms?: number;
  /** Time to first stream event (approx TTFB). */
  ttfb_ms?: number;
  /** Time to first text token. */
  ttft_ms?: number;
  /** LLM rounds in this run. */
  turns?: number;
  tool_use_count?: number;
  api_calls?: number;
}
