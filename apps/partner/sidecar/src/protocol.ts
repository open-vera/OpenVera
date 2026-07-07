import type { Message, Usage } from "@open-vera/core/types";

export interface RpcRequest {
  id: string;
  method: string;
  params?: Record<string, unknown>;
}

export interface AgentRunParams {
  sessionId: string;
  instanceId: string;
  message: string;
  history?: Message[];
  projectRoot: string;
  llmConfig?: PartnerLlmConfig;
}

export interface PartnerLlmConfig {
  provider: string;
  protocol: string;
  apiBaseUrl: string;
  model: string;
  apiKey: string;
}

export interface AgentAbortParams {
  sessionId: string;
}

export interface ToolResultMessage {
  id: string;
  type: "tool_result";
  data: {
    callId: string;
    output: string;
    isError?: boolean;
  };
}

export type StreamEventType =
  | "ready"
  | "delta"
  | "thinking"
  | "tool_call"
  | "tool_result"
  | "usage"
  | "done"
  | "error";

export interface StreamEvent {
  id: string;
  type: StreamEventType;
  data?: {
    instanceId?: string;
    text?: string;
    callId?: string;
    name?: string;
    input?: Record<string, unknown>;
    handledBySidecar?: boolean;
    output?: string;
    isError?: boolean;
    usage?: Usage;
    message?: string;
  };
}

export interface RpcResult {
  id: string;
  type: "result";
  data?: Record<string, unknown>;
}

export interface RpcError {
  id: string;
  type: "error";
  data?: { message?: string };
}

export function writeEvent(event: StreamEvent): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

export function writeResult(id: string, data: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ id, type: "result", data })}\n`);
}

export function writeError(id: string, message: string): void {
  process.stdout.write(
    `${JSON.stringify({ id, type: "error", data: { message } })}\n`,
  );
}

export function parseLine(line: string): RpcRequest | ToolResultMessage | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  return JSON.parse(trimmed) as RpcRequest | ToolResultMessage;
}
