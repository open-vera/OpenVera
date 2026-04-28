import type { LLMAdapter } from "../adapters/base.js";
import type {
  CompletionRequest,
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
  compressMessages,
  createCompressionState,
  microCompact,
  createMicroCompactState,
  isPromptTooLongError,
} from "../context/compression.js";

export type ToolHandler = (
  name: string,
  args: Record<string, unknown>
) => Promise<string> | string;

export interface ContextUpdate {
  compressionState: CompressionState | null;
  microCompactState: MicroCompactState | null;
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
   */
  onCompression?: (
    type: "progressive" | "micro" | "reactive",
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

// ── Compression helpers (shared by runAgent + streamAgent) ───────────────────

interface CompressResult {
  messages: Message[];
  compressionState: CompressionState | null;
}

async function applyProactiveCompress(
  messages: Message[],
  compressionState: CompressionState,
  options: AgentOptions,
  adapter: LLMAdapter,
  model: string,
  microCompactState: MicroCompactState | null,
  hooks: AgentHooks | undefined,
): Promise<CompressResult> {
  const before = messages.length;
  const compressed = await compressMessages(messages, compressionState, options.compressionOptions!, adapter, model);
  if (compressed.usage) options.onUsage?.(compressed.usage);
  options.onContextUpdate?.(compressed.messages, { compressionState: compressed.state, microCompactState });
  if (compressed.messages.length !== before) {
    await hooks?.onCompression?.("progressive", before, compressed.messages.length);
  }
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
): Promise<ReactiveCompactResult | null> {
  if (!isPromptTooLongError(err) || reactiveRetries >= maxRetries || !options.compressionOptions?.enabled) {
    return null;
  }
  await hooks?.onRetry?.("reactive_compact", reactiveRetries);
  const before = messages.length;
  const compressed = await compressMessages(
    messages,
    compressionState ?? createCompressionState(),
    options.compressionOptions,
    adapter,
    model,
    true,
  );
  options.onContextUpdate?.(compressed.messages, { compressionState: compressed.state, microCompactState });
  await hooks?.onCompression?.("reactive", before, compressed.messages.length);
  return { messages: compressed.messages, compressionState: compressed.state, retries: reactiveRetries + 1 };
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
  let messages: Message[] = [{ role: "user", content: userMessage }];

  // Circuit breaker: stop reactive compact retries after N consecutive failures
  const MAX_REACTIVE_RETRIES = 3;
  let reactiveRetries = 0;
  let result = "";
  let lastTurnHadToolResults = false;
  let emptyAfterToolRetries = 0;

  try {
    for (let turn = 0; shouldContinueTurns(turn, maxTurns); turn++) {
      // ── Auto-compact: proactive compression when over threshold ────────
      if (compressionState && options.compressionOptions) {
        const r = await applyProactiveCompress(messages, compressionState, options, adapter, model, microCompactState, hooks);
        messages = r.messages;
        compressionState = r.compressionState;
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
      if (prepResult.microCompactFired) {
        await hooks?.onCompression?.("micro", messages.length, messages.length);
      }

      const request: CompletionRequest = { model, messages: apiMessages, tools, system: activeSystem, signal };

      // ── onTurnStart ────────────────────────────────────────────────────
      await hooks?.onTurnStart?.(turn, apiMessages);

      // ── API call with reactive compact ─────────────────────────────────
      let response;
      try {
        response = await adapter.complete(request);
        reactiveRetries = 0;
      } catch (err) {
        const rc = await tryReactiveCompact(err, messages, compressionState, reactiveRetries, MAX_REACTIVE_RETRIES, options, adapter, model, microCompactState, hooks);
        if (rc) { messages = rc.messages; compressionState = rc.compressionState; reactiveRetries = rc.retries; continue; }
        throw err;
      }

      // ── onTurnEnd (before tool execution) ─────────────────────────────
      const assistantText = extractText(response.message);
      await hooks?.onTurnEnd?.(turn, response.usage, assistantText);

      messages.push(response.message);
      if (microCompactState) microCompactState = { ...microCompactState, lastAssistantTs: Date.now() };
      options.onContextUpdate?.(messages, { compressionState, microCompactState });

      const toolCalls = extractToolCalls(response.message);
      if (toolCalls.length === 0) {
        if (
          lastTurnHadToolResults &&
          assistantText.trim() === "" &&
          emptyAfterToolRetries < MAX_EMPTY_AFTER_TOOL_RETRIES &&
          hasAnotherTurnAfter(turn, maxTurns)
        ) {
          messages.push({ role: "user", content: EMPTY_AFTER_TOOL_RESULT_PROMPT });
          emptyAfterToolRetries++;
          lastTurnHadToolResults = false;
          options.onContextUpdate?.(messages, { compressionState, microCompactState });
          continue;
        }
        result = assistantText;
        break;
      }

      await handleToolCalls(response.message, messages, onToolCall, tools, budgetState, runDir);
      lastTurnHadToolResults = true;
      options.onContextUpdate?.(messages, { compressionState, microCompactState });
    }

    if (!result) {
      const lastMessage = messages[messages.length - 1];
      if (lastMessage) result = extractText(lastMessage);
    }
  } finally {
    await hooks?.onSessionEnd?.();
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

  try {
    for (let turn = 0; shouldContinueTurns(turn, maxTurns); turn++) {
      // ── Auto-compact: proactive compression when over threshold ────────
      if (compressionState && options.compressionOptions) {
        const r = await applyProactiveCompress(messages, compressionState, options, adapter, model, microCompactState, hooks);
        messages = r.messages;
        compressionState = r.compressionState;
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
      if (prepResult.microCompactFired) {
        await hooks?.onCompression?.("micro", messages.length, messages.length);
      }

      const request: CompletionRequest = { model, messages: apiMessages, tools, system: activeSystem, signal };

      // ── onTurnStart ────────────────────────────────────────────────────
      await hooks?.onTurnStart?.(turn, apiMessages);

      const collectedToolCalls: Array<{
        id: string;
        name: string;
        arguments: string;
      }> = [];
      let turnText = "";
      let turnUsage: Usage | undefined;

      // ── Stream with reactive compact ───────────────────────────────────
      try {
        for await (const event of adapter.stream(request)) {
          if (event.type === "text") {
            onText(event.text);
            turnText += event.text;
          } else if (event.type === "tool_call") {
            collectedToolCalls.push(event);
          } else if (event.type === "done") {
            turnUsage = event.usage;
            if (event.usage) onUsage?.(event.usage);
          }
        }
        reactiveRetries = 0;
      } catch (err) {
        const rc = await tryReactiveCompact(err, messages, compressionState, reactiveRetries, MAX_REACTIVE_RETRIES, options, adapter, model, microCompactState, hooks);
        if (rc) { messages = rc.messages; compressionState = rc.compressionState; reactiveRetries = rc.retries; continue; }
        throw err;
      }

      // ── onTurnEnd (before tool execution) ─────────────────────────────
      await hooks?.onTurnEnd?.(turn, turnUsage, turnText);

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
      messages.push({
        role: "assistant",
        content:
          assistantContent.length === 1 && assistantContent[0]?.type === "text"
            ? turnText
            : assistantContent,
      });
      if (microCompactState) microCompactState = { ...microCompactState, lastAssistantTs: Date.now() };
      options.onContextUpdate?.(messages, { compressionState, microCompactState });

      if (collectedToolCalls.length === 0) {
        if (
          lastTurnHadToolResults &&
          turnText.trim() === "" &&
          emptyAfterToolRetries < MAX_EMPTY_AFTER_TOOL_RETRIES &&
          hasAnotherTurnAfter(turn, maxTurns)
        ) {
          messages.push({ role: "user", content: EMPTY_AFTER_TOOL_RESULT_PROMPT });
          emptyAfterToolRetries++;
          lastTurnHadToolResults = false;
          options.onContextUpdate?.(messages, { compressionState, microCompactState });
          continue;
        }
        finalText = turnText;
        break;
      }

      // Execute tools and append results
      for (const tc of collectedToolCalls) {
        let args: Record<string, unknown>;
        try {
          args = JSON.parse(tc.arguments) as Record<string, unknown>;
        } catch {
          messages.push({
            role: "tool",
            tool_call_id: tc.id,
            content: `[Error: could not parse tool arguments — ${tc.arguments.slice(0, 200)}]`,
          });
          options.onContextUpdate?.(messages, { compressionState, microCompactState });
          continue;
        }
        const rawResult = onToolCall
          ? await onToolCall(tc.name, args)
          : `Tool "${tc.name}" called`;
        const maxChars = getToolMaxChars(tc.name, tools);
        const content = budgetState
          ? await processToolResult(tc.id, rawResult, budgetState, runDir, maxChars)
          : rawResult;
        messages.push({ role: "tool", tool_call_id: tc.id, content });
        options.onContextUpdate?.(messages, { compressionState, microCompactState });
      }
      lastTurnHadToolResults = true;
    }
  } finally {
    await hooks?.onSessionEnd?.();
  }

  return finalText;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

async function handleToolCalls(
  message: Message,
  messages: Message[],
  onToolCall: ToolHandler | undefined,
  tools: Tool[],
  budgetState: ToolResultBudgetState | null,
  runDir: string | undefined
): Promise<void> {
  const toolCalls = extractToolCalls(message);
  for (const tc of toolCalls) {
    let args: Record<string, unknown>;
    try {
      args = JSON.parse(tc.arguments) as Record<string, unknown>;
    } catch {
      messages.push({
        role: "tool",
        tool_call_id: tc.id,
        content: `[Error: could not parse tool arguments — ${tc.arguments.slice(0, 200)}]`,
      });
      continue;
    }
    const rawResult = onToolCall
      ? await onToolCall(tc.name, args)
      : `Tool "${tc.name}" called with ${JSON.stringify(args)}`;
    const maxChars = getToolMaxChars(tc.name, tools);
    const content = budgetState
      ? await processToolResult(tc.id, rawResult, budgetState, runDir, maxChars)
      : rawResult;
    messages.push({ role: "tool", tool_call_id: tc.id, content });
  }
}

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
