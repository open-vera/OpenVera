import type { LLMAdapter } from "../adapters/base.js";
import type { EventBus } from "@open-vera/plugin-runtime";
import type {
  CompletionRequest,
  CompletionResponse,
  Message,
  Tool,
  ContentPart,
  Usage,
} from "../types/index.js";
import {
  type ContextWindowOptions,
  getModelContextLimit,
  trimToWindow,
} from "../context/window.js";
import {
  type ToolResultBudgetState,
  createToolBudgetState,
  DEFAULT_MAX_RESULT_SIZE_CHARS,
  enforcePerTurnBudget,
  processToolResult,
  reapplyReplacements,
} from "../context/tool-budget.js";
import { estimateMessageTokens } from "../context/tokens.js";
import type { MemoryTracker, MemoryFile } from "../memory/index.js";
import {
  type CompressionOptions,
  type CompressionState,
  type CompressedSegment,
  type MicroCompactOptions,
  type MicroCompactState,
  type InsertCompressPending,
  compressMessages,
  createCompressionState,
  microCompact,
  createMicroCompactState,
  isPromptTooLongError,
  insertCompressionInstruction,
  resolveInsertCompress,
} from "../context/compression.js";
import { createLogger, previewForLog, sanitizeForLog, truncateForLog } from "@open-vera/logger";

const log = createLogger("agent:loop");

export type ToolHandler = (
  name: string,
  args: Record<string, unknown>
) => Promise<string> | string;

export interface ContextUpdate {
  compressionState: CompressionState | null;
  microCompactState: MicroCompactState | null;
}

export interface AgentLlmServiceLike {
  buildAdapter(
    provider?: string,
    model?: string,
    options?: { purpose?: "chat" | "routing" | "compression" | "vision" | "tool" },
  ): LLMAdapter;
}

// ── AgentHooks ────────────────────────────────────────────────────────────────

/**
 * Tiered lifecycle hooks for agent loop observability.
 *
 * Tier 1 — Turn lifecycle (most users): onTurnStart / onTurnEnd / onSessionEnd
 * Tier 2 — Advanced observability: onCompression / onRetry
 * Tier 3 — Tool interception: see ToolLifecycleHook in tools/types.ts
 */
export interface AgentHooks {
  // ── Tier 1: Turn lifecycle ─────────────────────────────────────────────────

  /**
   * Fired before each LLM API call. `messages` is what is actually sent
   * (after compression, window trimming, and budget enforcement).
   */
  onTurnStart?: (turn: number, messages: Message[]) => void | Promise<void>;

  /**
   * Fired after the assistant responds, before tool calls execute.
   * `usage` may be undefined when the adapter does not report it.
   */
  onTurnEnd?: (
    turn: number,
    usage: Usage | undefined,
    assistantText: string
  ) => void | Promise<void>;

  /**
   * Fired when the loop exits — natural completion, maxTurns reached, or abort.
   * Guaranteed via try/finally; fires even on errors.
   */
  onSessionEnd?: () => void | Promise<void>;

  // ── Tier 2: Advanced observability ────────────────────────────────────────

  /**
   * Fired when context compression runs.
   * - "progressive": proactive LLM summarisation; before/after = message count.
   * - "reactive":    prompt-too-long emergency compress; before/after = message count.
   * - "micro":       time-gap heuristic content clearing; before === after
   *                  (message count unchanged — the event is the signal).
   * - "insert-compress": insert-then-compress instruction injected (OC1).
   * - "insert-resolved": insert-then-compress output resolved after API call (OC1).
   */
  onCompression?: (
    type: "progressive" | "micro" | "reactive" | "insert-compress" | "insert-resolved",
    before: number,
    after: number
  ) => void | Promise<void>;

  /** Fired before a reactive-compact retry attempt. */
  onRetry?: (reason: "reactive_compact", turn: number) => void | Promise<void>;
}

export interface AgentOptions {
  adapter: LLMAdapter;
  model: string;
  tools?: Tool[];
  onToolCall?: ToolHandler;
  onUsage?: (usage: Usage) => void;
  /** Called with each thinking/reasoning delta from the LLM. */
  onThinking?: (delta: string) => void;
  system?: string;
  maxTurns?: number;
  /**
   * Prior conversation turns to prepend before the new user message.
   * Enables multi-turn memory across separate streamAgent calls.
   */
  history?: Message[];
  /**
   * Context-window options. Defaults to 75% of the model's known limit with
   * a minimum of 6 recent turns preserved.
   * Pass `false` to disable sliding-window trimming entirely.
   */
  contextOptions?: Partial<ContextWindowOptions> | false;
  /**
   * Directory for persisting large tool results.
   * When provided, tool outputs exceeding their `maxResultSizeChars` threshold
   * are written to `<runDir>/tool-results/<id>.txt` and replaced with a
   * preview + filepath message so the full content remains accessible.
   * When omitted, budget enforcement is disabled (results are kept in-memory).
   */
  runDir?: string;
  /** AbortSignal to cancel the current request mid-stream. */
  signal?: AbortSignal;
  /**
   * MemoryTracker for dynamic memory injection + usage detection.
   * When set, the agent loop will auto-select relevant memories each turn,
   * record injections, and detect usage after the model responds.
   */
  memoryTracker?: MemoryTracker;
  /**
   * Pre-scanned list of available memory files (from MemoryTracker.scan()).
   * Required when memoryTracker is set. Pass the same array each turn
   * or re-scan periodically.
   */
  scannedMemoryFiles?: MemoryFile[];
  /**
   * Callback fired each turn with the selected memory files, so the caller
   * can inject their content into the system prompt or user message.
   */
  onMemorySelected?: (memories: MemoryFile[]) => string;
  /**
   * Progressive compression of old conversation turns.
   * When enabled, turns beyond the keep-recent window are compressed
   * by an LLM into a structured summary instead of being dropped.
   * Default: disabled.
   */
  compressionOptions?: CompressionOptions;
  /** Optional adapter override for LLM-based context compression. */
  compressionAdapter?: LLMAdapter;
  /** Optional purpose-aware LLM service used for compression when no explicit compressionAdapter is provided. */
  llmService?: AgentLlmServiceLike;
  /** Optional provider override for compression LLM calls through llmService. */
  compressionProvider?: string;
  /**
   * Time-based micro-compact: clears old tool results when the gap since
   * the last assistant message exceeds the threshold. Pure heuristic,
   * no LLM call. Default: disabled.
   */
  microCompactOptions?: MicroCompactOptions;
  /**
   * Persisted compression state from previous turns. When omitted, a fresh
   * state is created for this run if compression is enabled.
   */
  compressionState?: CompressionState;
  /**
   * Persisted micro-compact state from previous turns. When omitted, a fresh
   * state is created for this run if micro-compact is enabled.
   */
  microCompactState?: MicroCompactState;
  /**
   * Called whenever the model-facing history changes. REPL callers use this
   * to carry compressed/cleared context forward into the next user turn while
   * keeping the raw session log unchanged.
   */
  onContextUpdate?: (messages: Message[], update: ContextUpdate) => void;

  /** Lifecycle hooks for observing turn, session, compression, and retry events. */
  hooks?: AgentHooks;
  /** Plugin runtime event bus for stable observe-only agent loop events. */
  eventBus?: EventBus;
  /** Stable session identifier included in plugin event DTOs when available. */
  sessionId?: string;
  /** Stable trace identifier included in plugin event DTOs when available. */
  traceId?: string;
}

// Match Claude Code's main thread behavior: no default loop cap. Callers can
// still pass maxTurns for bounded subflows such as planning or compaction.
export const DEFAULT_MAX_TURNS: number | undefined = undefined;

// Appended to every system prompt so the model knows to keep calling tools
// until the task is fully complete — same pattern Claude Code uses.
const AGENTIC_SYSTEM_SUFFIX = `

You have access to tools. Use them continuously until the task is fully complete.
After receiving a tool result, decide if more tool calls are needed and call them immediately — do not stop to summarize until the work is done.
When the user asks what to do next, asks about current status, or gives a workspace-relative request without enough details, inspect the current workspace with read-only tools first (for example list_dir, grep, glob, or read_file) before asking follow-up questions.
Only ask the user for input when you are genuinely blocked and cannot proceed without their answer.`;

const EMPTY_AFTER_TOOL_RESULT_PROMPT =
  "The previous tool result has been provided, but your last response was empty. Continue from that tool result: either call another tool to recover, or provide a concise final answer if no more tools are needed.";

// Max retries when the assistant returns empty text immediately after a tool result.
// 1 was too low — a single fluke causes silent failure; 3 gives the model enough
// attempts without masking persistent empty-response bugs.
const MAX_EMPTY_AFTER_TOOL_RETRIES = 3;

// ── Context helpers ───────────────────────────────────────────────────────────

function parseToolArgsForLog(args: string): unknown {
  try {
    return sanitizeForLog(JSON.parse(args) as unknown);
  } catch {
    return { raw: truncateForLog(args) };
  }
}

function summarizeContentForLog(content: Message["content"]): unknown {
  if (typeof content === "string") {
    return { type: "text", length: content.length, preview: truncateForLog(content) };
  }
  return content.map((part) => {
    switch (part.type) {
      case "text":
        return { type: "text", length: part.text.length, preview: truncateForLog(part.text) };
      case "thinking":
        return { type: "thinking", length: part.thinking.length, preview: truncateForLog(part.thinking) };
      case "tool_call":
        return {
          type: "tool_call",
          id: part.id,
          name: part.name,
          args: parseToolArgsForLog(part.arguments),
        };
      case "tool_result":
        return {
          type: "tool_result",
          tool_call_id: part.tool_call_id,
          length: part.content.length,
          preview: truncateForLog(part.content),
        };
      case "image_url":
        return { type: "image_url", url: sanitizeForLog(part.image_url.url) };
    }
  });
}

function summarizeMessagesForLog(messages: Message[]): unknown[] {
  return messages.map((message, index) => ({
    index,
    role: message.role,
    tool_call_id: message.tool_call_id,
    content: summarizeContentForLog(message.content),
  }));
}

function summarizeToolCallsForLog(
  toolCalls: Array<{ id: string; name: string; arguments: string }>
): unknown[] {
  return toolCalls.map((tc) => ({
    id: tc.id,
    name: tc.name,
    args: parseToolArgsForLog(tc.arguments),
  }));
}

function extractThinking(message: Message): string {
  if (typeof message.content === "string") return "";
  return message.content
    .filter((p): p is ContentPart & { type: "thinking" } => p.type === "thinking")
    .map((p) => p.thinking)
    .join("\n");
}

function logLlmRequest(turn: number, request: CompletionRequest): void {
  log.debug("llm request", {
    turn,
    model: request.model,
    messageCount: request.messages.length,
    messages: summarizeMessagesForLog(request.messages),
    toolCount: request.tools?.length ?? 0,
    tools: request.tools?.map((tool) => tool.name) ?? [],
    systemLen: request.system?.length ?? 0,
    systemPreview: request.system ? truncateForLog(request.system) : undefined,
    max_tokens: request.max_tokens,
    thinking_budget: request.thinking_budget,
  });
}

function buildWindowOptions(
  model: string,
  contextOptions: AgentOptions["contextOptions"]
): ContextWindowOptions | null {
  if (contextOptions === false) return null;
  const limit = getModelContextLimit(model);
  return {
    maxTokens: limit,
    targetUtilization: 0.75,
    keepRecentTurns: 6,
    ...(contextOptions ?? {}),
  };
}

/** Apply all pre-call context transformations; returns messages for the API. */
async function prepareMessages(
  messages: Message[],
  budgetState: ToolResultBudgetState | null,
  windowOpts: ContextWindowOptions | null,
  runDir: string | undefined,
  microCompactState: MicroCompactState | null,
  microCompactOpts: MicroCompactOptions | undefined,
): Promise<{
  contextMessages: Message[];
  apiMessages: Message[];
  microCompactState: MicroCompactState | null;
  microCompactFired: boolean;
}> {
  let msgs = messages;
  let mcState = microCompactState;
  let microCompactFired = false;

  if (budgetState) {
    msgs = reapplyReplacements(msgs, budgetState);
    msgs = await enforcePerTurnBudget(msgs, budgetState, runDir);
  }

  // Micro-compact: clear old tool results (before window trim).
  // microCompact returns the original reference when nothing is cleared,
  // so reference inequality is a reliable fired-check.
  if (mcState && microCompactOpts) {
    const before = msgs;
    const result = microCompact(msgs, mcState, microCompactOpts);
    microCompactFired = result.messages !== before;
    msgs = result.messages;
    mcState = result.state;
  }

  const contextMessages = msgs;
  const apiMessages = windowOpts ? trimToWindow(contextMessages, windowOpts) : contextMessages;

  return { contextMessages, apiMessages, microCompactState: mcState, microCompactFired };
}

/** Resolve the maxResultSizeChars for a named tool. */
function getToolMaxChars(
  name: string,
  tools: Tool[] | undefined
): number {
  const tool = tools?.find((t) => t.name === name);
  if (tool?.maxResultSizeChars !== undefined) return tool.maxResultSizeChars;
  return DEFAULT_MAX_RESULT_SIZE_CHARS;
}

function shouldContinueTurns(turn: number, maxTurns: number | undefined): boolean {
  return maxTurns === undefined || turn < maxTurns;
}

function hasAnotherTurnAfter(turn: number, maxTurns: number | undefined): boolean {
  return maxTurns === undefined || turn < maxTurns - 1;
}

function resolveCompressionAdapter(options: AgentOptions, fallback: LLMAdapter, model: string): LLMAdapter {
  if (options.compressionAdapter) return options.compressionAdapter;
  if (options.llmService) {
    return options.llmService.buildAdapter(
      options.compressionProvider,
      options.compressionOptions?.model ?? model,
      { purpose: "compression" },
    );
  }
  return fallback;
}

// ── Compression helpers (shared by runAgent + streamAgent) ───────────────────

interface CompressResult {
  messages: Message[];
  compressionState: CompressionState | null;
  /** Non-null when insert-then-compress was used; caller must resolve after API call. */
  pendingCompression?: InsertCompressPending;
}

type AgentLoopMode = "streaming" | "non-streaming";

interface AgentEventBase {
  mode: AgentLoopMode;
  model: string;
  turn?: number;
}

interface ToolExecutionOptions {
  onToolCall: ToolHandler | undefined;
  tools: Tool[];
  budgetState: ToolResultBudgetState | null;
  runDir: string | undefined;
  eventBus: EventBus | undefined;
  agentOptions: AgentOptions;
  eventBase: AgentEventBase;
  defaultToolResult?: (name: string, args: Record<string, unknown>) => string;
  onToolResult?: (tool: { name: string; args: Record<string, unknown>; content: string }) => void;
  onContextUpdate?: () => void;
}

async function emitAgentObserve(
  eventBus: EventBus | undefined,
  eventName: string,
  value: Record<string, unknown>,
  options: AgentOptions,
  base: AgentEventBase,
): Promise<void> {
  await eventBus?.emitObserve(eventName, {
    ...base,
    ...(options.sessionId ? { sessionId: options.sessionId } : {}),
    ...(options.traceId ? { traceId: options.traceId } : {}),
    ...value,
  }, {
    pluginId: "agent-loop",
    sessionId: options.sessionId,
    signal: options.signal,
    metadata: {
      mode: base.mode,
      model: base.model,
      ...(base.turn !== undefined ? { turn: base.turn } : {}),
      ...(options.traceId ? { traceId: options.traceId } : {}),
    },
  });
}

function summarizeMessagesForEvent(messages: Message[]): Record<string, unknown> {
  return {
    count: messages.length,
    roles: messages.map((message) => message.role),
    estimatedTokens: estimateMessageTokens(messages),
  };
}

function summarizeToolArgsForEvent(args: Record<string, unknown>): unknown {
  return sanitizeForLog(args, 2_000);
}

function summarizeToolResultForEvent(content: string): Record<string, unknown> {
  return {
    length: content.length,
    preview: previewForLog(content, 2_000),
  };
}

function errorForEvent(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
    };
  }
  return {
    name: "Error",
    message: String(error),
  };
}

function summarizeCompletionRequestForEvent(request: CompletionRequest): Record<string, unknown> {
  return {
    model: request.model,
    messages: summarizeMessagesForEvent(request.messages),
    toolCount: request.tools?.length ?? 0,
    tools: request.tools?.map((tool) => tool.name) ?? [],
    systemLength: request.system?.length ?? 0,
    maxTokens: request.max_tokens,
    temperature: request.temperature,
    thinkingBudget: request.thinking_budget,
  };
}

function summarizeCompletionResponseForEvent(response: CompletionResponse): Record<string, unknown> {
  const toolCalls = extractToolCalls(response.message);
  return {
    stopReason: response.stop_reason,
    usage: response.usage,
    assistantTextLength: extractText(response.message).length,
    toolCalls: toolCalls.map((toolCall) => ({
      id: toolCall.id,
      name: toolCall.name,
    })),
  };
}

async function emitLlmRequest(
  request: CompletionRequest,
  options: AgentOptions,
  eventBase: AgentEventBase,
): Promise<void> {
  await emitAgentObserve(options.eventBus, "llm:request", summarizeCompletionRequestForEvent(request), options, eventBase);
}

async function emitLlmResponse(
  response: CompletionResponse,
  options: AgentOptions,
  eventBase: AgentEventBase,
): Promise<void> {
  await emitAgentObserve(options.eventBus, "llm:response", summarizeCompletionResponseForEvent(response), options, eventBase);
}

async function emitLlmStreamResponse(
  result: StreamTurnResult,
  options: AgentOptions,
  eventBase: AgentEventBase,
): Promise<void> {
  await emitAgentObserve(options.eventBus, "llm:response", {
    streamed: true,
    usage: result.turnUsage,
    assistantTextLength: result.turnText.length,
    toolCalls: result.collectedToolCalls.map((toolCall) => ({
      id: toolCall.id,
      name: toolCall.name,
    })),
  }, options, eventBase);
}

async function emitLlmError(
  error: unknown,
  options: AgentOptions,
  eventBase: AgentEventBase,
): Promise<void> {
  await emitAgentObserve(options.eventBus, "llm:error", {
    error: errorForEvent(error),
  }, options, eventBase);
}

async function emitTurnRetry(
  reason: "reactive_compact" | "empty_after_tool_result",
  attempt: number,
  options: AgentOptions,
  eventBase: AgentEventBase,
  extra: Record<string, unknown> = {},
): Promise<void> {
  await emitAgentObserve(options.eventBus, "turn:retry", {
    reason,
    attempt,
    ...extra,
  }, options, eventBase);
}

async function applyProactiveCompress(
  messages: Message[],
  compressionState: CompressionState,
  options: AgentOptions,
  adapter: LLMAdapter,
  model: string,
  microCompactState: MicroCompactState | null,
  hooks: AgentHooks | undefined,
  eventBus: EventBus | undefined,
  eventBase: AgentEventBase,
): Promise<CompressResult> {
  const opts = options.compressionOptions!;

  // OC1: Insert-then-compress — insert instruction into conversation flow
  if (opts.insertCompress) {
    const result = insertCompressionInstruction(messages, opts);
    if (!result) return { messages, compressionState };
    await hooks?.onCompression?.("insert-compress", messages.length, result.messages.length);
    await emitAgentObserve(eventBus, "compression:after", {
      type: "insert-compress",
      before: messages.length,
      after: result.messages.length,
    }, options, eventBase);
    return { messages: result.messages, compressionState, pendingCompression: result.pending };
  }

  // Traditional approach: separate API call for compression
  const before = messages.length;
  await emitAgentObserve(eventBus, "compression:before", {
    type: "progressive",
    before,
  }, options, eventBase);
  const compressed = await compressMessages(
    messages,
    compressionState,
    opts,
    resolveCompressionAdapter(options, adapter, model),
    opts.model ?? model,
  );
  if (compressed.usage) options.onUsage?.(compressed.usage);
  options.onContextUpdate?.(compressed.messages, { compressionState: compressed.state, microCompactState });
  if (compressed.messages.length !== before) {
    await hooks?.onCompression?.("progressive", before, compressed.messages.length);
  }
  await emitAgentObserve(eventBus, "compression:after", {
    type: "progressive",
    before,
    after: compressed.messages.length,
    usage: compressed.usage,
  }, options, eventBase);
  return { messages: compressed.messages, compressionState: compressed.state };
}

interface ReactiveCompactResult extends CompressResult {
  retries: number;
}

async function tryReactiveCompact(
  err: unknown,
  messages: Message[],
  compressionState: CompressionState | null,
  reactiveRetries: number,
  maxRetries: number,
  options: AgentOptions,
  adapter: LLMAdapter,
  model: string,
  microCompactState: MicroCompactState | null,
  hooks: AgentHooks | undefined,
  eventBus: EventBus | undefined,
  eventBase: AgentEventBase,
): Promise<ReactiveCompactResult | null> {
  if (!isPromptTooLongError(err) || reactiveRetries >= maxRetries || !options.compressionOptions?.enabled) {
    return null;
  }
  await hooks?.onRetry?.("reactive_compact", reactiveRetries);
  await emitTurnRetry("reactive_compact", reactiveRetries + 1, options, eventBase, {
    maxRetries,
    error: errorForEvent(err),
  });
  const before = messages.length;
  await emitAgentObserve(eventBus, "compression:before", {
    type: "reactive",
    before,
    retry: reactiveRetries,
  }, options, eventBase);
  const compressed = await compressMessages(
    messages,
    compressionState ?? createCompressionState(),
    options.compressionOptions,
    resolveCompressionAdapter(options, adapter, model),
    options.compressionOptions.model ?? model,
    true,
  );
  options.onContextUpdate?.(compressed.messages, { compressionState: compressed.state, microCompactState });
  await hooks?.onCompression?.("reactive", before, compressed.messages.length);
  await emitAgentObserve(eventBus, "compression:after", {
    type: "reactive",
    before,
    after: compressed.messages.length,
    retry: reactiveRetries + 1,
    usage: compressed.usage,
  }, options, eventBase);
  return { messages: compressed.messages, compressionState: compressed.state, retries: reactiveRetries + 1 };
}

type CompletionAttempt =
  | { status: "ok"; response: CompletionResponse }
  | {
      status: "retry";
      messages: Message[];
      compressionState: CompressionState | null;
      reactiveRetries: number;
    };

type ReactiveCompactRetry = {
  status: "retry";
  messages: Message[];
  compressionState: CompressionState | null;
  reactiveRetries: number;
};

async function reactiveCompactOnError(
  err: unknown,
  messages: Message[],
  compressionState: CompressionState | null,
  reactiveRetries: number,
  maxReactiveRetries: number,
  options: AgentOptions,
  adapter: LLMAdapter,
  model: string,
  microCompactState: MicroCompactState | null,
  hooks: AgentHooks | undefined,
  eventBus: EventBus | undefined,
  eventBase: AgentEventBase,
): Promise<ReactiveCompactRetry | null> {
  const rc = await tryReactiveCompact(
    err,
    messages,
    compressionState,
    reactiveRetries,
    maxReactiveRetries,
    options,
    adapter,
    model,
    microCompactState,
    hooks,
    eventBus,
    eventBase
  );
  if (!rc) return null;
  return {
    status: "retry",
    messages: rc.messages,
    compressionState: rc.compressionState,
    reactiveRetries: rc.retries,
  };
}

async function completeWithReactiveCompact(
  request: CompletionRequest,
  messages: Message[],
  compressionState: CompressionState | null,
  reactiveRetries: number,
  maxReactiveRetries: number,
  options: AgentOptions,
  adapter: LLMAdapter,
  model: string,
  microCompactState: MicroCompactState | null,
  hooks: AgentHooks | undefined,
  eventBus: EventBus | undefined,
  eventBase: AgentEventBase,
): Promise<CompletionAttempt> {
  try {
    await emitLlmRequest(request, options, eventBase);
    const response = await adapter.complete(request);
    await emitLlmResponse(response, options, eventBase);
    return { status: "ok", response };
  } catch (err) {
    await emitLlmError(err, options, eventBase);
    const retry = await reactiveCompactOnError(
      err,
      messages,
      compressionState,
      reactiveRetries,
      maxReactiveRetries,
      options,
      adapter,
      model,
      microCompactState,
      hooks,
      eventBus,
      eventBase
    );
    if (!retry) throw err;
    return retry;
  }
}

interface StreamTurnResult {
  status: "ok";
  turnText: string;
  turnThinking: string;
  turnUsage: Usage | undefined;
  collectedToolCalls: Array<{ id: string; name: string; arguments: string }>;
}

async function streamTurnWithReactiveCompact(
  request: CompletionRequest,
  messages: Message[],
  compressionState: CompressionState | null,
  reactiveRetries: number,
  maxReactiveRetries: number,
  options: AgentOptions,
  adapter: LLMAdapter,
  model: string,
  microCompactState: MicroCompactState | null,
  hooks: AgentHooks | undefined,
  eventBus: EventBus | undefined,
  eventBase: AgentEventBase,
  onText: (delta: string) => void,
  onThinking: ((text: string) => void) | undefined,
  onUsage: ((usage: Usage) => void) | undefined
): Promise<StreamTurnResult | ReactiveCompactRetry> {
  const collectedToolCalls: Array<{ id: string; name: string; arguments: string }> = [];
  let turnText = "";
  let turnThinking = "";
  let turnUsage: Usage | undefined;

  try {
    await emitLlmRequest(request, options, eventBase);
    for await (const event of adapter.stream(request)) {
      if (event.type === "text") {
        onText(event.text);
        turnText += event.text;
      } else if (event.type === "thinking") {
        onThinking?.(event.text);
        turnThinking += event.text;
      } else if (event.type === "tool_call") {
        collectedToolCalls.push(event);
      } else if (event.type === "done") {
        turnUsage = event.usage;
        if (event.usage) onUsage?.(event.usage);
      }
    }
    const result = { status: "ok" as const, turnText, turnThinking, turnUsage, collectedToolCalls };
    await emitLlmStreamResponse(result, options, eventBase);
    return result;
  } catch (err) {
    await emitLlmError(err, options, eventBase);
    const retry = await reactiveCompactOnError(
      err,
      messages,
      compressionState,
      reactiveRetries,
      maxReactiveRetries,
      options,
      adapter,
      model,
      microCompactState,
      hooks,
      eventBus,
      eventBase
    );
    if (!retry) throw err;
    return retry;
  }
}

function shouldOmitEmptyAssistantMessage(message: Message): boolean {
  return (
    message.role === "assistant" &&
    !extractText(message).trim() &&
    extractToolCalls(message).length === 0
  );
}

async function resolveInsertCompressIfNeeded(
  messages: Message[],
  assistantText: string,
  pendingCompression: InsertCompressPending | undefined,
  compressionState: CompressionState | null,
  hooks: AgentHooks | undefined
): Promise<{ messages: Message[]; compressionState: CompressionState | null; assistantText: string }> {
  if (!pendingCompression || !compressionState) {
    return { messages, compressionState, assistantText };
  }

  const resolved = resolveInsertCompress(messages, assistantText, pendingCompression, compressionState);
  if (!resolved) return { messages, compressionState, assistantText };

  const lastMsg = resolved.messages[resolved.messages.length - 1];
  await hooks?.onCompression?.("insert-resolved", resolved.messages.length, resolved.messages.length);
  return {
    messages: resolved.messages,
    compressionState: resolved.state,
    assistantText: lastMsg ? extractText(lastMsg) : assistantText,
  };
}

function finalizeNoToolCalls(
  assistantText: string,
  lastTurnHadToolResults: boolean,
  emptyAfterToolRetries: number,
  turn: number,
  maxTurns: number | undefined
): { outcome: "done" | "retry_empty"; result?: string } {
  if (
    lastTurnHadToolResults &&
    assistantText.trim() === "" &&
    emptyAfterToolRetries < MAX_EMPTY_AFTER_TOOL_RETRIES &&
    hasAnotherTurnAfter(turn, maxTurns)
  ) {
    return { outcome: "retry_empty" };
  }
  return { outcome: "done", result: assistantText };
}

async function appendToolArgumentParseError(
  tc: { id: string; name: string; arguments: string },
  messages: Message[],
  options: ToolExecutionOptions,
): Promise<void> {
  const content = `[Error: could not parse tool arguments — ${tc.arguments.slice(0, 200)}]`;
  await emitAgentObserve(options.eventBus, `tool:error:${tc.name}`, {
    toolCallId: tc.id,
    name: tc.name,
    phase: "parse_args",
    rawArgumentsLength: tc.arguments.length,
    rawArgumentsPreview: truncateForLog(tc.arguments, 2_000),
    error: {
      name: "SyntaxError",
      message: "Could not parse tool arguments as JSON",
    },
  }, options.agentOptions, options.eventBase);
  messages.push({
    role: "tool",
    tool_call_id: tc.id,
    content,
  });
  options.onContextUpdate?.();
}

async function executeOneToolCall(
  tc: { id: string; name: string; arguments: string },
  messages: Message[],
  options: ToolExecutionOptions,
): Promise<void> {
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(tc.arguments) as Record<string, unknown>;
  } catch {
    await appendToolArgumentParseError(tc, messages, options);
    return;
  }

  await emitAgentObserve(options.eventBus, `tool:before:${tc.name}`, {
    toolCallId: tc.id,
    name: tc.name,
    args: summarizeToolArgsForEvent(args),
  }, options.agentOptions, options.eventBase);

  log.debug("tool call start", {
    turn: options.eventBase.turn,
    toolCallId: tc.id,
    tool: tc.name,
    args: sanitizeForLog(args),
  });

  let rawResult: string;
  try {
    rawResult = options.onToolCall
      ? await options.onToolCall(tc.name, args)
      : options.defaultToolResult?.(tc.name, args) ?? `Tool "${tc.name}" called`;
  } catch (error) {
    await emitAgentObserve(options.eventBus, `tool:error:${tc.name}`, {
      toolCallId: tc.id,
      name: tc.name,
      phase: "execute",
      args: summarizeToolArgsForEvent(args),
      error: errorForEvent(error),
    }, options.agentOptions, options.eventBase);
    throw error;
  }

  const maxChars = getToolMaxChars(tc.name, options.tools);
  const content = options.budgetState
    ? await processToolResult(tc.id, rawResult, options.budgetState, options.runDir, maxChars)
    : rawResult;

  log.debug("tool call result", {
    turn: options.eventBase.turn,
    toolCallId: tc.id,
    tool: tc.name,
    rawResultLen: rawResult.length,
    resultLen: content.length,
    resultPreview: previewForLog(content),
    budgeted: content !== rawResult,
  });

  await emitAgentObserve(options.eventBus, `tool:after:${tc.name}`, {
    toolCallId: tc.id,
    name: tc.name,
    args: summarizeToolArgsForEvent(args),
    result: summarizeToolResultForEvent(content),
    budgeted: content !== rawResult,
  }, options.agentOptions, options.eventBase);

  messages.push({ role: "tool", tool_call_id: tc.id, content });
  options.onToolResult?.({ name: tc.name, args, content });
  options.onContextUpdate?.();
}

async function executeToolCalls(
  toolCalls: Array<{ id: string; name: string; arguments: string }>,
  messages: Message[],
  options: ToolExecutionOptions,
): Promise<void> {
  for (const tc of toolCalls) {
    await executeOneToolCall(tc, messages, options);
  }
}

// ── Non-streaming agent ───────────────────────────────────────────────────────

/** Non-streaming run; returns the final text response. */
export async function runAgent(
  userMessage: string,
  options: AgentOptions
): Promise<string> {
  const {
    adapter,
    model,
    tools = [],
    onToolCall,
    system,
    maxTurns = DEFAULT_MAX_TURNS,
    runDir,
    signal,
    hooks,
  } = options;

  const activeSystem = system ? system + AGENTIC_SYSTEM_SUFFIX : AGENTIC_SYSTEM_SUFFIX.trim();

  const windowOpts = buildWindowOptions(model, options.contextOptions);
  const budgetState = runDir ? createToolBudgetState() : null;
  let compressionState =
    options.compressionOptions?.enabled
      ? options.compressionState ?? createCompressionState()
      : null;
  let microCompactState =
    options.microCompactOptions?.enabled
      ? options.microCompactState ?? createMicroCompactState()
      : null;
  let messages: Message[] = [...(options.history ?? []), { role: "user", content: userMessage }];

  // Circuit breaker: stop reactive compact retries after N consecutive failures
  const MAX_REACTIVE_RETRIES = 3;
  let reactiveRetries = 0;
  let result = "";
  let lastTurnHadToolResults = false;
  let emptyAfterToolRetries = 0;

  log.debug("runAgent start", { model, maxTurns });

  try {
    for (let turn = 0; shouldContinueTurns(turn, maxTurns); turn++) {
      // ── Auto-compact: proactive compression when over threshold ────────
      let pendingCompression: InsertCompressPending | undefined;
      if (compressionState && options.compressionOptions) {
        const r = await applyProactiveCompress(
          messages,
          compressionState,
          options,
          adapter,
          model,
          microCompactState,
          hooks,
          options.eventBus,
          { mode: "non-streaming", model, turn },
        );
        messages = r.messages;
        compressionState = r.compressionState;
        pendingCompression = r.pendingCompression;
      }

      // ── Prepare messages (budget → micro-compact → window trim) ───────
      const prepResult = await prepareMessages(
        messages, budgetState, windowOpts, runDir,
        microCompactState, options.microCompactOptions,
      );
      messages = prepResult.contextMessages;
      const apiMessages = prepResult.apiMessages;
      microCompactState = prepResult.microCompactState;
      options.onContextUpdate?.(messages, { compressionState, microCompactState });
      await emitAgentObserve(options.eventBus, "context:select", {
        context: summarizeMessagesForEvent(messages),
      }, options, { mode: "non-streaming", model, turn });
      await emitAgentObserve(options.eventBus, "context:inject", {
        api: summarizeMessagesForEvent(apiMessages),
      }, options, { mode: "non-streaming", model, turn });
      if (prepResult.microCompactFired) {
        await hooks?.onCompression?.("micro", messages.length, messages.length);
        await emitAgentObserve(options.eventBus, "compression:after", {
          type: "micro",
          before: messages.length,
          after: messages.length,
        }, options, { mode: "non-streaming", model, turn });
      }

      const request: CompletionRequest = { model, messages: apiMessages, tools, system: activeSystem, signal };
      logLlmRequest(turn, request);

      // ── onTurnStart ────────────────────────────────────────────────────
      await hooks?.onTurnStart?.(turn, apiMessages);
      await emitAgentObserve(options.eventBus, "turn:start", {
        messages: summarizeMessagesForEvent(apiMessages),
        toolCount: tools.length,
      }, options, { mode: "non-streaming", model, turn });

      // ── API call with reactive compact ─────────────────────────────────
      const completion = await completeWithReactiveCompact(
        request,
        messages,
        compressionState,
        reactiveRetries,
        MAX_REACTIVE_RETRIES,
        options,
        adapter,
        model,
        microCompactState,
        hooks,
        options.eventBus,
        { mode: "non-streaming", model, turn },
      );
      if (completion.status === "retry") {
        messages = completion.messages;
        compressionState = completion.compressionState;
        reactiveRetries = completion.reactiveRetries;
        continue;
      }
      reactiveRetries = 0;
      const response = completion.response;

      // ── onTurnEnd (before tool execution) ─────────────────────────────
      let assistantText = extractText(response.message);
      const assistantThinking = extractThinking(response.message);
      await hooks?.onTurnEnd?.(turn, response.usage, assistantText);
      await emitAgentObserve(options.eventBus, "turn:end", {
        usage: response.usage,
        assistantTextLength: assistantText.length,
        toolCalls: extractToolCalls(response.message).map((toolCall) => ({
          id: toolCall.id,
          name: toolCall.name,
        })),
      }, options, { mode: "non-streaming", model, turn });
      log.debug("llm response", {
        turn,
        stop_reason: response.stop_reason,
        usage: response.usage,
        textLen: assistantText.length,
        textPreview: truncateForLog(assistantText),
        thinkingLen: assistantThinking.length,
        thinkingPreview: truncateForLog(assistantThinking),
        toolCalls: summarizeToolCallsForLog(extractToolCalls(response.message)),
      });

      if (!shouldOmitEmptyAssistantMessage(response.message)) {
        messages.push(response.message);
      }
      if (microCompactState) microCompactState = { ...microCompactState, lastAssistantTs: Date.now() };

      // ── OC1: Resolve insert-then-compress ─────────────────────────────
      const resolvedInsert = await resolveInsertCompressIfNeeded(
        messages,
        assistantText,
        pendingCompression,
        compressionState,
        hooks
      );
      messages = resolvedInsert.messages;
      compressionState = resolvedInsert.compressionState;
      assistantText = resolvedInsert.assistantText;

      options.onContextUpdate?.(messages, { compressionState, microCompactState });

      const toolCalls = extractToolCalls(response.message);
      if (toolCalls.length === 0) {
        const noTools = finalizeNoToolCalls(
          assistantText,
          lastTurnHadToolResults,
          emptyAfterToolRetries,
          turn,
          maxTurns
        );
        if (noTools.outcome === "retry_empty") {
          await emitTurnRetry("empty_after_tool_result", emptyAfterToolRetries + 1, options, { mode: "non-streaming", model, turn }, {
            maxRetries: MAX_EMPTY_AFTER_TOOL_RETRIES,
          });
          messages.push({ role: "user", content: EMPTY_AFTER_TOOL_RESULT_PROMPT });
          emptyAfterToolRetries++;
          options.onContextUpdate?.(messages, { compressionState, microCompactState });
          continue;
        }
        result = noTools.result ?? assistantText;
        break;
      }

      await executeToolCalls(toolCalls, messages, {
        onToolCall,
        tools,
        budgetState,
        runDir,
        eventBus: options.eventBus,
        agentOptions: options,
        eventBase: { mode: "non-streaming", model, turn },
        defaultToolResult: (name, args) => `Tool "${name}" called with ${JSON.stringify(args)}`,
      });
      lastTurnHadToolResults = true;
      options.onContextUpdate?.(messages, { compressionState, microCompactState });
    }

    if (!result) {
      const lastMessage = messages[messages.length - 1];
      if (lastMessage) result = extractText(lastMessage);
    }
  } finally {
    await hooks?.onSessionEnd?.();
    log.debug("runAgent end", { resultLen: result.length });
  }

  return result;
}

// ── Memory injection helper ─────────────────────────────────────────────────

/**
 * Run one turn of memory selection + injection before the API call.
 * Returns the memory preamble string to include in the system prompt,
 * or "" when memory tracking is disabled.
 */
function selectAndRecordMemories(
  tracker: MemoryTracker | undefined,
  scannedFiles: MemoryFile[] | undefined,
  onSelected: ((memories: MemoryFile[]) => string) | undefined,
): string {
  if (!tracker || !scannedFiles || scannedFiles.length === 0) return "";

  const selected = tracker.selectForInjection(scannedFiles);
  if (selected.length === 0) return "";

  tracker.recordInjection(selected.map((f) => f.path));

  if (onSelected) return onSelected(selected);

  // Default formatting when no callback is provided
  const lines = selected.map(
    (m) =>
      `[memory: ${m.filename}]${m.description ? ` — ${m.description}` : ""}`,
  );
  return `\n\nRelevant memories for this turn:\n${lines.join("\n")}`;
}

function injectMemoryContext(messages: Message[], memoryPreamble: string): Message[] {
  const content = memoryPreamble.trim();
  if (!content) return messages;
  return [
    {
      role: "user",
      content: `<dynamic-memory-context>\n${content}\n</dynamic-memory-context>`,
    },
    ...messages,
  ];
}

// ── Streaming agent ───────────────────────────────────────────────────────────

/** Streaming run; calls `onText` with each text delta. Returns full text. */
export async function streamAgent(
  userMessage: string,
  options: AgentOptions,
  onText: (delta: string) => void
): Promise<string> {
  const {
    adapter,
    model,
    tools = [],
    onToolCall,
    onUsage,
    onThinking,
    system,
    maxTurns = DEFAULT_MAX_TURNS,
    runDir,
    signal,
    history = [],
    memoryTracker,
    scannedMemoryFiles,
    onMemorySelected,
    hooks,
  } = options;

  const windowOpts = buildWindowOptions(model, options.contextOptions);
  const budgetState = runDir ? createToolBudgetState() : null;
  let compressionState =
    options.compressionOptions?.enabled
      ? options.compressionState ?? createCompressionState()
      : null;
  let microCompactState =
    options.microCompactOptions?.enabled
      ? options.microCompactState ?? createMicroCompactState()
      : null;
  let messages: Message[] = [...history, { role: "user", content: userMessage }];
  let finalText = "";
  const activeSystem = system ? system + AGENTIC_SYSTEM_SUFFIX : AGENTIC_SYSTEM_SUFFIX.trim();

  const MAX_REACTIVE_RETRIES = 3;
  let reactiveRetries = 0;
  let lastTurnHadToolResults = false;
  let emptyAfterToolRetries = 0;

  log.debug("streamAgent start", { model, turnCount: history.length > 0 ? history.length : 0, maxTurns });

  try {
    for (let turn = 0; shouldContinueTurns(turn, maxTurns); turn++) {
      const turnStartMs = Date.now();
      // ── Auto-compact: proactive compression when over threshold ────────
      let pendingCompression: InsertCompressPending | undefined;
      if (compressionState && options.compressionOptions) {
        const r = await applyProactiveCompress(
          messages,
          compressionState,
          options,
          adapter,
          model,
          microCompactState,
          hooks,
          options.eventBus,
          { mode: "streaming", model, turn },
        );
        messages = r.messages;
        compressionState = r.compressionState;
        pendingCompression = r.pendingCompression;
      }

      // ── Memory: select + inject ────────────────────────────────────────
      const memoryPreamble = selectAndRecordMemories(
        memoryTracker,
        scannedMemoryFiles,
        onMemorySelected,
      );
      // ── Prepare messages (budget → micro-compact → window trim) ───────
      const prepResult = await prepareMessages(
        messages, budgetState, windowOpts, runDir,
        microCompactState, options.microCompactOptions,
      );
      messages = prepResult.contextMessages;
      const apiMessages = injectMemoryContext(prepResult.apiMessages, memoryPreamble);
      microCompactState = prepResult.microCompactState;
      options.onContextUpdate?.(messages, { compressionState, microCompactState });
      await emitAgentObserve(options.eventBus, "context:select", {
        context: summarizeMessagesForEvent(messages),
        memoryInjected: Boolean(memoryPreamble.trim()),
      }, options, { mode: "streaming", model, turn });
      await emitAgentObserve(options.eventBus, "context:inject", {
        api: summarizeMessagesForEvent(apiMessages),
        memoryInjected: Boolean(memoryPreamble.trim()),
      }, options, { mode: "streaming", model, turn });
      if (prepResult.microCompactFired) {
        await hooks?.onCompression?.("micro", messages.length, messages.length);
        await emitAgentObserve(options.eventBus, "compression:after", {
          type: "micro",
          before: messages.length,
          after: messages.length,
        }, options, { mode: "streaming", model, turn });
      }

      const request: CompletionRequest = { model, messages: apiMessages, tools, system: activeSystem, signal };
      logLlmRequest(turn, request);

      // ── onTurnStart ────────────────────────────────────────────────────
      await hooks?.onTurnStart?.(turn, apiMessages);
      await emitAgentObserve(options.eventBus, "turn:start", {
        messages: summarizeMessagesForEvent(apiMessages),
        toolCount: tools.length,
      }, options, { mode: "streaming", model, turn });

      const streamResult = await streamTurnWithReactiveCompact(
        request,
        messages,
        compressionState,
        reactiveRetries,
        MAX_REACTIVE_RETRIES,
        options,
        adapter,
        model,
        microCompactState,
        hooks,
        options.eventBus,
        { mode: "streaming", model, turn },
        onText,
        onThinking,
        onUsage
      );
      if (streamResult.status === "retry") {
        messages = streamResult.messages;
        compressionState = streamResult.compressionState;
        reactiveRetries = streamResult.reactiveRetries;
        continue;
      }
      reactiveRetries = 0;
      const { turnText, turnThinking, turnUsage, collectedToolCalls } = streamResult;

      // ── onTurnEnd (before tool execution) ─────────────────────────────
      await hooks?.onTurnEnd?.(turn, turnUsage, turnText);
      await emitAgentObserve(options.eventBus, "turn:end", {
        usage: turnUsage,
        assistantTextLength: turnText.length,
        toolCalls: collectedToolCalls.map((toolCall) => ({
          id: toolCall.id,
          name: toolCall.name,
        })),
      }, options, { mode: "streaming", model, turn });

      log.debug("turn completed", {
        turn,
        duration_ms: Date.now() - turnStartMs,
        textLen: turnText.length,
        textPreview: truncateForLog(turnText),
        thinkingLen: turnThinking.length,
        thinkingPreview: truncateForLog(turnThinking),
        toolCalls: collectedToolCalls.length,
        toolCallDetails: summarizeToolCallsForLog(collectedToolCalls),
        usage: turnUsage,
      });

      // ── Memory: detect usage from this turn's response ─────────────────
      if (memoryTracker && scannedMemoryFiles && turnText) {
        void memoryTracker.detectAndUpdate(turnText, scannedMemoryFiles);
      }

      // Append assistant turn to history
      const assistantContent: ContentPart[] = [];
      if (turnText) assistantContent.push({ type: "text", text: turnText });
      for (const tc of collectedToolCalls) {
        assistantContent.push({
          type: "tool_call",
          id: tc.id,
          name: tc.name,
          arguments: tc.arguments,
        });
      }
      // Filter out empty assistant messages that would cause API errors
      if (assistantContent.length > 0 || turnText.trim()) {
        messages.push({
          role: "assistant",
          content:
            assistantContent.length === 1 && assistantContent[0]?.type === "text"
              ? turnText
              : assistantContent,
        });
      }
      if (microCompactState) microCompactState = { ...microCompactState, lastAssistantTs: Date.now() };

      // ── OC1: Resolve insert-then-compress ─────────────────────────────
      const resolvedInsert = await resolveInsertCompressIfNeeded(
        messages,
        turnText,
        pendingCompression,
        compressionState,
        hooks
      );
      messages = resolvedInsert.messages;
      compressionState = resolvedInsert.compressionState;

      options.onContextUpdate?.(messages, { compressionState, microCompactState });

      if (collectedToolCalls.length === 0) {
        const noTools = finalizeNoToolCalls(
          turnText,
          lastTurnHadToolResults,
          emptyAfterToolRetries,
          turn,
          maxTurns
        );
        if (noTools.outcome === "retry_empty") {
          await emitTurnRetry("empty_after_tool_result", emptyAfterToolRetries + 1, options, { mode: "streaming", model, turn }, {
            maxRetries: MAX_EMPTY_AFTER_TOOL_RETRIES,
          });
          messages.push({ role: "user", content: EMPTY_AFTER_TOOL_RESULT_PROMPT });
          emptyAfterToolRetries++;
          options.onContextUpdate?.(messages, { compressionState, microCompactState });
          continue;
        }
        finalText = noTools.result ?? turnText;
        break;
      }

      // Execute tools and append results
      await executeToolCalls(collectedToolCalls, messages, {
        onToolCall,
        tools,
        budgetState,
        runDir,
        eventBus: options.eventBus,
        agentOptions: options,
        eventBase: { mode: "streaming", model, turn },
        onContextUpdate: () => options.onContextUpdate?.(messages, { compressionState, microCompactState }),
      });
      lastTurnHadToolResults = true;
    }
  } finally {
    await hooks?.onSessionEnd?.();
    log.debug("streamAgent end", { finalTextLen: finalText.length });
  }

  return finalText;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function extractText(message: Message): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .filter((p): p is ContentPart & { type: "text" } => p.type === "text")
    .map((p) => p.text)
    .join("\n");
}

function extractToolCalls(
  message: Message
): Array<{ id: string; name: string; arguments: string }> {
  if (typeof message.content === "string") return [];
  return message.content
    .filter(
      (p): p is ContentPart & { type: "tool_call" } => p.type === "tool_call"
    )
    .map((p) => ({ id: p.id, name: p.name, arguments: p.arguments }));
}

// ── Re-export context utilities ───────────────────────────────────────────────
export { estimateMessageTokens, getModelContextLimit, trimToWindow };
export type {
  ContextWindowOptions,
  ToolResultBudgetState,
  CompressionOptions,
  CompressionState,
  CompressedSegment,
  MicroCompactOptions,
  MicroCompactState,
};
