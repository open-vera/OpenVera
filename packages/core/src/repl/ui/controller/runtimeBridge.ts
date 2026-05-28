import { streamAgent } from "../../../agent/loop.js";
import type { AgentOptions } from "../../../agent/loop.js";
import type { PlanExecutor, PlanRunContext } from "../../../plan/index.js";
import type { ToolResult } from "../../../tools/types.js";
import type { ToolUse } from "../types.js";
import type { UiEvent } from "../events.js";

export interface StreamRuntimeBridgeOptions {
  line: string;
  agentOptions: AgentOptions;
  streamAgentImpl?: typeof streamAgent;
  onTextDelta: (delta: string) => void;
  dispatchUiEvent: (event: UiEvent) => void;
  streamingBufferRef: { current: string };
  rafRef: { current: ReturnType<typeof setTimeout> | null };
  toolCallHandler: (name: string, args: Record<string, unknown>, onOutput?: (chunk: string) => void) => Promise<ToolResult>;
  formatError: (err: unknown) => string;
  onComplete?: (fullText: string) => void;
  onError?: (message: string, err: unknown, isAbort: boolean) => void;
}

export interface PlanRuntimeBridgeOptions {
  line: string;
  planExecutor: PlanExecutor;
  planContext: PlanRunContext;
  handlePlanEvent: Parameters<PlanExecutor>[2];
  captureUsage: Parameters<PlanExecutor>[3];
  dispatchUiEvent: (event: UiEvent) => void;
  clearPendingPlanFrame: () => void;
  formatError: (err: unknown) => string;
  onComplete?: () => void;
  onError?: (message: string, err: unknown, isAbort: boolean) => void;
}

export function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || err.message.includes("aborted"));
}

export async function runStreamRuntime(options: StreamRuntimeBridgeOptions): Promise<void> {
  const {
    line,
    agentOptions,
    streamAgentImpl = streamAgent,
    onTextDelta,
    dispatchUiEvent,
    streamingBufferRef,
    rafRef,
    toolCallHandler,
    formatError,
    onComplete,
    onError,
  } = options;

  dispatchUiEvent({ type: "assistant.started" });
  dispatchUiEvent({ type: "status.changed", status: "streaming" });
  streamingBufferRef.current = "";

  try {
    const fullText = await streamAgentImpl(
      line,
      {
        ...agentOptions,
        onToolCall: async (name, args) => {
          if (rafRef.current !== null) {
            clearTimeout(rafRef.current);
            rafRef.current = null;
          }
          const preface = streamingBufferRef.current.trim();
          streamingBufferRef.current = "";
          dispatchUiEvent({ type: "tool.started", name, args, preface });
          const onOutput = (chunk: string) => dispatchUiEvent({ type: "tool.output", chunk });
          const toolResult = await toolCallHandler(name, args, onOutput);
          const toolUse: ToolUse = { name, args, result: toolResult, ...(preface ? { preface } : {}) };
          dispatchUiEvent({ type: "tool.completed", tool: toolUse });
          return toolResult.content;
        },
      },
      onTextDelta,
    );

    if (rafRef.current !== null) {
      clearTimeout(rafRef.current);
      rafRef.current = null;
    }
    streamingBufferRef.current = fullText;
    dispatchUiEvent({ type: "assistant.completed", text: fullText });
    onComplete?.(fullText);
  } catch (err) {
    if (rafRef.current !== null) {
      clearTimeout(rafRef.current);
      rafRef.current = null;
    }
    const isAbort = isAbortError(err);
    const errMsg = isAbort ? "Cancelled." : formatError(err);
    dispatchUiEvent({ type: "assistant.failed", message: errMsg, preservePartial: true });
    onError?.(errMsg, err, isAbort);
  } finally {
    dispatchUiEvent({ type: "status.changed", status: "idle" });
  }
}

export async function runPlanRuntime(options: PlanRuntimeBridgeOptions): Promise<void> {
  const {
    line,
    planExecutor,
    planContext,
    handlePlanEvent,
    captureUsage,
    dispatchUiEvent,
    clearPendingPlanFrame,
    formatError,
    onComplete,
    onError,
  } = options;

  dispatchUiEvent({ type: "status.changed", status: "planning" });

  try {
    await planExecutor(line, planContext, handlePlanEvent, captureUsage);
    onComplete?.();
  } catch (err) {
    clearPendingPlanFrame();
    const isAbort = isAbortError(err);
    const message = isAbort ? "Cancelled." : formatError(err);
    onError?.(message, err, isAbort);
  } finally {
    dispatchUiEvent({ type: "status.changed", status: "idle" });
  }
}
