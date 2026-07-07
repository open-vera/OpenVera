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
}

export interface ToolResult {
  id: string;
  output: string;
  isError?: boolean;
}

export interface ChatErrorNotice {
  id: string;
  message: string;
  timestamp: number;
}

export type ChatAttachmentKind = "text" | "image" | "binary";

export interface ChatAttachment {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  kind: ChatAttachmentKind;
  content?: string;
  dataUrl?: string;
  truncated?: boolean;
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
}

export interface ChatTab {
  id: string;
  title: string;
  kind: "chat" | "settings";
  messages: Message[];
  isAgentRunning: boolean;
  lastError?: ChatErrorNotice | null;
  currentTokenCount: number;
  estimatedCost: number;
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
}

export type LLMProviderId = string;
export type LLMProtocol = "anthropic" | "openai-compatible" | "gemini";
export type AppLocale = "zh" | "en";

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
  configScope?: string;
  configExists: boolean;
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
}
