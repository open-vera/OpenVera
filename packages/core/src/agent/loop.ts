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
  compressMessages,
  createCompressionState,
} from "../context/compression.js";

export type ToolHandler = (
  name: string,
  args: Record<string, unknown>
) => Promise<string> | string;

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
}

// Claude Code uses 200 as the default agent loop limit.
export const DEFAULT_MAX_TURNS = 200;

// Appended to every system prompt so the model knows to keep calling tools
// until the task is fully complete — same pattern Claude Code uses.
const AGENTIC_SYSTEM_SUFFIX = `

You have access to tools. Use them continuously until the task is fully complete.
After receiving a tool result, decide if more tool calls are needed and call them immediately — do not stop to summarize until the work is done.
Only ask the user for input when you are genuinely blocked and cannot proceed without their answer.`;

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
  runDir: string | undefined
): Promise<Message[]> {
  let msgs = messages;

  if (budgetState) {
    // Re-apply frozen replacements (byte-identical, prompt-cache stable)
    msgs = reapplyReplacements(msgs, budgetState);
    // Enforce per-turn aggregate budget
    msgs = await enforcePerTurnBudget(msgs, budgetState, runDir);
  }

  if (windowOpts) {
    msgs = trimToWindow(msgs, windowOpts);
  }

  return msgs;
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
  } = options;

  const activeSystem = system ? system + AGENTIC_SYSTEM_SUFFIX : AGENTIC_SYSTEM_SUFFIX.trim();

  const windowOpts = buildWindowOptions(model, options.contextOptions);
  const budgetState = runDir ? createToolBudgetState() : null;
  let compressionState =
    options.compressionOptions?.enabled ? createCompressionState() : null;
  let messages: Message[] = [{ role: "user", content: userMessage }];

  for (let turn = 0; turn < maxTurns; turn++) {
    if (compressionState && options.compressionOptions) {
      const result = await compressMessages(
        messages,
        compressionState,
        options.compressionOptions,
        adapter,
        model,
      );
      messages = result.messages;
      compressionState = result.state;
    }

    const apiMessages = await prepareMessages(messages, budgetState, windowOpts, runDir);
    const request: CompletionRequest = { model, messages: apiMessages, tools, system: activeSystem, signal };
    const response = await adapter.complete(request);
    messages.push(response.message);

    if (response.stop_reason !== "tool_use") {
      return extractText(response.message);
    }

    await handleToolCalls(response.message, messages, onToolCall, tools, budgetState, runDir);
  }

  return extractText(messages[messages.length - 1]!);
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
    maxTurns = 10,
    runDir,
    signal,
    history = [],
    memoryTracker,
    scannedMemoryFiles,
    onMemorySelected,
  } = options;

  const windowOpts = buildWindowOptions(model, options.contextOptions);
  const budgetState = runDir ? createToolBudgetState() : null;
  let compressionState =
    options.compressionOptions?.enabled ? createCompressionState() : null;
  let messages: Message[] = [...history, { role: "user", content: userMessage }];
  let fullText = "";

  for (let turn = 0; turn < maxTurns; turn++) {
    // ── Compression: progressive summarization of old turns ──────────────
    if (compressionState && options.compressionOptions) {
      const result = await compressMessages(
        messages,
        compressionState,
        options.compressionOptions,
        adapter,
        model,
      );
      messages = result.messages;
      compressionState = result.state;
    }

    // ── Memory: select + inject ──────────────────────────────────────────
    const memoryPreamble = selectAndRecordMemories(
      memoryTracker,
      scannedMemoryFiles,
      onMemorySelected,
    );
    const turnSystem = system
      ? system + memoryPreamble
      : memoryPreamble.trim() || undefined;

    const apiMessages = await prepareMessages(messages, budgetState, windowOpts, runDir);
    const request: CompletionRequest = { model, messages: apiMessages, tools, system: turnSystem, signal };

    const collectedToolCalls: Array<{
      id: string;
      name: string;
      arguments: string;
    }> = [];
    let turnText = "";
    let stopReason = "end_turn";

    for await (const event of adapter.stream(request)) {
      if (event.type === "text") {
        onText(event.text);
        turnText += event.text;
      } else if (event.type === "tool_call") {
        collectedToolCalls.push(event);
      } else if (event.type === "done") {
        stopReason = event.stop_reason;
        if (event.usage) onUsage?.(event.usage);
      }
    }

    // ── Memory: detect usage from this turn's response ──────────────────
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
        assistantContent.length === 1 && assistantContent[0]!.type === "text"
          ? turnText
          : assistantContent,
    });

    fullText += turnText;

    if (stopReason !== "tool_use" && collectedToolCalls.length === 0) break;

    // Execute tools and append results
    for (const tc of collectedToolCalls) {
      const args = JSON.parse(tc.arguments) as Record<string, unknown>;
      const rawResult = onToolCall
        ? await onToolCall(tc.name, args)
        : `Tool "${tc.name}" called`;
      const maxChars = getToolMaxChars(tc.name, tools);
      const content = budgetState
        ? await processToolResult(tc.id, rawResult, budgetState, runDir, maxChars)
        : rawResult;
      messages.push({ role: "tool", tool_call_id: tc.id, content });
    }
  }

  return fullText;
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
    const args = JSON.parse(tc.arguments) as Record<string, unknown>;
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
};
