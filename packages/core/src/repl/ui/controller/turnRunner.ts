import type React from "react";
import { streamAgent, type AgentOptions } from "../../../agent/loop.js";
import type { PlanExecutor, PlanRunContext, PlanStepUI } from "../../../plan/index.js";
import type { AccumulatedCost } from "../../../session/index.js";
import type { ToolResult } from "../../../tools/types.js";
import type { Message, Usage } from "../../../types/index.js";
import type { UiEvent } from "../events.js";
import type { ChatMessage } from "../types.js";
import { buildPlanEventHandler } from "../hooks/usePlanRunner.js";
import { formatRuntimeError } from "./errorFormatting.js";
import { runPlanRuntime, runStreamRuntime } from "./runtimeBridge.js";
import {
  appendPlanPlaceholder,
  reducePlanRuntimeError,
  summarizePlanSteps,
} from "./turnLifecycle.js";
import {
  appendCompletedTurnHistory,
  persistAssistantTurn,
  persistTurnEnd,
  type TurnPersistenceStore,
} from "./turnPersistence.js";

export interface RefLike<T> {
  current: T;
}

export interface PreparedTurnRunnerOptions {
  line: string;
  usePlanMode: boolean;
  routingFailed: boolean;
  activeModel: string;
  activeProvider: string;
  userUuid: string;
  turnStartMs: number;
  store: TurnPersistenceStore;
  turnCountRef: RefLike<number>;
  historyRef: RefLike<Message[]>;
  costRef: RefLike<AccumulatedCost>;
  turnToolCalls: string[];
  getTurnUsage: () => Usage;
  writeAiTitleIfNeeded: (assistantText: string) => void;
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  dispatchUiEvent: (event: UiEvent) => void;
  onTextDelta: (delta: string) => void;
  captureUsage: (usage: Usage) => void;
  clearAbort: () => void;
  plan: {
    executor: PlanExecutor;
    context: PlanRunContext;
    stepsRef: RefLike<PlanStepUI[]>;
    stepTextRef: RefLike<string>;
    rafRef: RefLike<ReturnType<typeof setTimeout> | null>;
  };
  stream: {
    agentOptions: AgentOptions;
    streamAgentImpl?: typeof streamAgent;
    streamingBufferRef: RefLike<string>;
    rafRef: RefLike<ReturnType<typeof setTimeout> | null>;
    toolCallHandler: (name: string, args: Record<string, unknown>) => Promise<ToolResult>;
  };
}

export async function runPreparedTurn(options: PreparedTurnRunnerOptions): Promise<void> {
  try {
    if (options.usePlanMode) {
      await runPreparedPlanTurn(options);
      return;
    }
    await runPreparedStreamTurn(options);
  } finally {
    options.clearAbort();
  }
}

async function runPreparedPlanTurn(options: PreparedTurnRunnerOptions): Promise<void> {
  options.plan.stepsRef.current = [];
  options.plan.stepTextRef.current = "";
  options.setMessages((prev) => appendPlanPlaceholder(prev));

  const handlePlanEvent = buildPlanEventHandler({
    setMessages: options.setMessages,
    dispatchUiEvent: options.dispatchUiEvent,
    planStepsRef: options.plan.stepsRef,
    planStepTextRef: options.plan.stepTextRef,
    planRafRef: options.plan.rafRef,
  });

  await runPlanRuntime({
    line: options.line,
    planExecutor: options.plan.executor,
    planContext: options.plan.context,
    handlePlanEvent,
    captureUsage: options.captureUsage,
    dispatchUiEvent: options.dispatchUiEvent,
    clearPendingPlanFrame: () => {
      if (options.plan.rafRef.current !== null) {
        clearTimeout(options.plan.rafRef.current);
        options.plan.rafRef.current = null;
      }
    },
    formatError: formatRuntimeError,
    onComplete: () => {
      const fullText = summarizePlanSteps(options.plan.stepsRef.current);
      persistAssistantTurn({
        store: options.store,
        parentUuid: options.userUuid,
        content: fullText,
        model: options.activeModel,
        provider: options.activeProvider,
        usage: options.getTurnUsage(),
        turnCount: options.turnCountRef.current,
        turnStartMs: options.turnStartMs,
        toolCalls: options.turnToolCalls,
        status: "ok",
      });
      options.historyRef.current = appendCompletedTurnHistory(options.historyRef.current, options.line, fullText);
      options.writeAiTitleIfNeeded(fullText);
      options.turnCountRef.current += 1;
    },
    onError: (message, _err, isAbort) => {
      options.setMessages((prev) => reducePlanRuntimeError(prev, message, isAbort));
    },
  });
}

async function runPreparedStreamTurn(options: PreparedTurnRunnerOptions): Promise<void> {
  await runStreamRuntime({
    line: options.line,
    agentOptions: options.stream.agentOptions,
    streamAgentImpl: options.stream.streamAgentImpl,
    onTextDelta: options.onTextDelta,
    dispatchUiEvent: options.dispatchUiEvent,
    streamingBufferRef: options.stream.streamingBufferRef,
    rafRef: options.stream.rafRef,
    toolCallHandler: options.stream.toolCallHandler,
    formatError: formatRuntimeError,
    onComplete: (fullText) => {
      options.writeAiTitleIfNeeded(fullText);
      persistAssistantTurn({
        store: options.store,
        parentUuid: options.userUuid,
        content: fullText,
        model: options.activeModel,
        provider: options.activeProvider,
        usage: options.getTurnUsage(),
        turnCount: options.turnCountRef.current,
        turnStartMs: options.turnStartMs,
        toolCalls: options.turnToolCalls,
        status: "ok",
      });
      options.turnCountRef.current += 1;
    },
    onError: (errMsg, _err, isAbort) => {
      if (!isAbort) {
        persistAssistantTurn({
          store: options.store,
          parentUuid: options.userUuid,
          content: errMsg,
          model: options.activeModel,
          provider: options.activeProvider,
          usage: options.getTurnUsage(),
          turnCount: options.turnCountRef.current,
          turnStartMs: options.turnStartMs,
          toolCalls: options.turnToolCalls,
          status: "error",
        });
      }
      persistTurnEnd(options.store, options.costRef.current, options.turnCountRef.current, options.line);
    },
  });
}
