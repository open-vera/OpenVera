import { useApp, useStdout, Box, Text } from "ink";
import React, { useState, useRef, useEffect, useCallback } from "react";
import { loadAgentDefinitions } from "../../agent/subagent.js";
import { shouldPlan } from "../../intent/classifier.js";
import type { IntentResult } from "../../intent/classifier.js";
import { defaultPlanExecutor } from "../../plan/index.js";
import type { PlanStepUI } from "../../plan/index.js";
import { accumulateCost, emptyAccumulatedCost } from "../../session/index.js";
import type { AccumulatedCost } from "../../session/index.js";
import type { ReplContext } from "../context.js";
import { debugLog } from "../debugLog.js";
import type { Usage, Message } from "../../types/index.js";
import { MemoryTracker } from "../../memory/index.js";
import type { MemoryFile } from "../../memory/index.js";
import type { ProjectContext } from "../../project-context/index.js";
import {
  createCompressionState,
  createMicroCompactState,
} from "../../context/index.js";
import type { CompressionState, MicroCompactState } from "../../context/index.js";
import { ConversationPanel } from "./ConversationPanel.js";
import { ActivityLane } from "./ActivityLane.js";
import { InputBar } from "./InputBar.js";
import { OverlayHost } from "./OverlayHost.js";
import { StatusBar } from "./StatusBar.js";
import { WelcomeScreen } from "./WelcomeScreen.js";
import type { RoutingInfo } from "./types.js";
import { theme } from "./theme.js";
import { useReplController } from "./controller/useReplController.js";
import { parseSlashCommand } from "./controller/slashCommands.js";
import { handleSlashCommandSubmission } from "./controller/commandSubmission.js";
import { formatRuntimeError } from "./controller/errorFormatting.js";
import { runExternalEditorRuntime } from "./controller/externalEditorRuntime.js";
import { schedulePathCandidateRefresh } from "./controller/pathCompletion.js";
import {
  MEMORY_REFRESH_TURNS,
} from "./controller/turnContext.js";
import { prepareTurnContext } from "./controller/turnContextRuntime.js";
import { normalizePromptIntent, prepareTurnSetup } from "./controller/turnSetup.js";
import { resolveTurnRouting } from "./controller/routing.js";
import {
  maybeGenerateAiTitle,
  type AiTitleState,
} from "./controller/sessionTitle.js";
import {
  runPreparedTurn,
} from "./controller/turnRunner.js";
import { accumulateTurnUsage, emptyTurnUsage } from "./controller/turnUsage.js";
import { useSessionLifecycle } from "./hooks/useSessionLifecycle.js";
import { useStreamingHelpers } from "./hooks/useStreamingHelpers.js";
import { buildToolCallHandler } from "./hooks/useToolCallHandler.js";
import { useFocusRecent, formatRecentLine } from "./hooks/useFocusRecent.js";

interface AppProps {
  ctx: ReplContext;
  resumeSessionId?: string;
}

export function App({ ctx, resumeSessionId }: AppProps) {
  const { exit } = useApp();
  const { stdout } = useStdout();

  const [dimensions, setDimensions] = useState({
    columns: stdout.columns ?? 80,
    rows: stdout.rows ?? 24,
  });

  useEffect(() => {
    const onResize = () => setDimensions({ columns: stdout.columns ?? 80, rows: stdout.rows ?? 24 });
    stdout.on("resize", onResize);
    return () => { stdout.off("resize", onResize); };
  }, [stdout]);

  const ctxRef = useRef<ReplContext>(ctx);
  const streamingBufferRef = useRef("");
  const thinkingBufferRef = useRef("");
  const rafRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const historyRef = useRef<Message[]>([]);
  const compressionStateRef = useRef<CompressionState>(createCompressionState());
  const microCompactStateRef = useRef<MicroCompactState>(createMicroCompactState());
  const memoryTrackerRef = useRef<MemoryTracker | null>(null);
  const frozenMemoryFilesRef = useRef<MemoryFile[]>([]);
  const frozenMemorySignatureRef = useRef("");
  const frozenMemoryTurnRef = useRef(-MEMORY_REFRESH_TURNS);
  const projectContextRef = useRef<ProjectContext | null>(null);
  const loadedVeraContextPathsRef = useRef<Set<string>>(new Set());
  const aiTitleStateRef = useRef<AiTitleState>({
    hasCustomTitle: false,
    generated: false,
    attempts: 0,
  });
  const inputHistoryRef = useRef<string[]>([]);
  const costRef = useRef<AccumulatedCost>(emptyAccumulatedCost());
  const turnCountRef = useRef(0);
  const latestInputTokensRef = useRef(0);
  const planStepTextRef = useRef("");
  const planRafRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const planStepsRef = useRef<PlanStepUI[]>([]);

  const [inputValue, setInputValue] = useState("");
  const {
    messages,
    activeTurn,
    streamStatus,
    usage,
    setMessages,
    setUsage,
    dispatchUiEvent,
    overlay,
    dispatchOverlay,
    openBlockingPrompt,
    queue,
    enqueue,
    prepend,
    dequeue,
    updateQueued,
    removeQueued,
    clearQueue,
  } = useReplController();
  const [pathCandidates, setPathCandidates] = useState<string[]>([]);
  useEffect(() => {
    const refresh = schedulePathCandidateRefresh({ cwd: ctx.cwd, setCandidates: setPathCandidates });
    return refresh.cancel;
  }, [ctx.cwd]);
  const [scrollOffset, setScrollOffset] = useState(0);
  const [expandToolOutput, setExpandToolOutput] = useState(false);
  const isFollowingRef = useRef(true);
  const { summary: recentSummary, dismiss: dismissRecent } = useFocusRecent({ messages, streamStatus });
  const [routing, setRouting] = useState<RoutingInfo>({
    provider: ctx.config.default_provider ?? "anthropic",
    model: ctx.model,
    intent: null,
  });

  // ── Session lifecycle ────────────────────────────────────────────────────────

  useSessionLifecycle({
    ctx, resumeSessionId, ctxRef,
    historyRef, compressionStateRef, microCompactStateRef,
    memoryTrackerRef, frozenMemoryFilesRef, frozenMemorySignatureRef,
    frozenMemoryTurnRef, loadedVeraContextPathsRef, projectContextRef,
    costRef, turnCountRef, inputHistoryRef,
    setMessages, setUsage,
    setSessionPickerOpen: (open) => dispatchOverlay({ type: open ? "open.sessionPicker" : "close" }),
  });

  // Wire onSwitchProvider so commands can update the UI when switching providers
  useEffect(() => {
    ctxRef.current.onSwitchProvider = (provider, model) => {
      setRouting((prev) => ({ ...prev, provider, model }));
    };
    ctxRef.current.onSwitchModel = (model) => {
      setRouting((prev) => ({ ...prev, model }));
    };
  }, []);

  // ── Streaming helpers ────────────────────────────────────────────────────────

  const { onTextDelta, onThinkingDelta, onUsage, handleCancel, handleScrollUp, handleScrollDown } = useStreamingHelpers({
    streamingBufferRef, thinkingBufferRef, rafRef, abortRef,
    costRef, latestInputTokensRef,
    routing, inputValue, streamStatus, rows: dimensions.rows,
    setMessages, setUsage,
    setScrollOffset, setInputValue,
    prependPendingInput: prepend,
    onAssistantUpdate: (text) => dispatchUiEvent({ type: "assistant.updated", text }),
    onThinkingUpdate: (text) => dispatchUiEvent({ type: "assistant.thinking.updated", text }),
    onUiEvent: dispatchUiEvent,
  });

  // ── Main submit handler ──────────────────────────────────────────────────────

  const handleSubmit = useCallback(async (line: string) => {
    if (streamStatus !== "idle") {
      enqueue(line);
      return;
    }

    const slashCommand = parseSlashCommand(line);
    const isSlashCommand = slashCommand !== null;

    if (!isSlashCommand) {
      dispatchUiEvent({ type: "user.submitted", text: line });
      inputHistoryRef.current = [...inputHistoryRef.current, line];
      isFollowingRef.current = true;
      setScrollOffset(0);
    }

    // ── Commands ──────────────────────────────────────────────────────────────

    if (slashCommand) {
      debugLog(`[handleSubmit] slash command: /${slashCommand.cmd} args=${JSON.stringify(slashCommand.args)}`);
      const t0 = Date.now();
      await handleSlashCommandSubmission({
        line,
        slashCommand,
        ctx: ctxRef.current,
        routing,
        usage,
        latestInputTokens: latestInputTokensRef.current,
        turnCount: turnCountRef.current,
        cost: costRef.current,
        lastInput: inputHistoryRef.current.at(-1),
        aiTitleState: aiTitleStateRef.current,
        queue: {
          items: queue.items,
          clearQueue,
          removeQueued,
          updateQueued,
        },
        setMessages,
        dispatchOverlay,
        exit,
      });
      debugLog(`[handleSubmit] /${slashCommand.cmd} completed in ${Date.now() - t0}ms, overlay=${overlay.type}`);
      return;
    }

    // ── Turn setup ────────────────────────────────────────────────────────────

    const userUuid = ctxRef.current.sessionStore.writeUser(line);

    const routingResult = await resolveTurnRouting({
      line,
      ctx: ctxRef.current,
      onRoutingStart: () => dispatchUiEvent({ type: "status.changed", status: "thinking" }),
      onClassifierUsage: ({ usage: classifierUsage, model, provider }) => {
        const updated = accumulateCost(costRef.current, classifierUsage, model, provider);
        costRef.current = updated;
        setUsage((prev) => ({
          ...prev,
          inputTotal: prev.inputTotal + (classifierUsage.input_tokens ?? 0),
          outputTotal: prev.outputTotal + (classifierUsage.output_tokens ?? 0),
          costUsd: updated.totalUsd,
        }));
      },
    });
    const activeAdapter = routingResult.adapter;
    const activeModel = routingResult.model;
    const activeProvider = routingResult.provider;
    const activeIntent: IntentResult | null = routingResult.intent;
    const routingFailed = routingResult.failed;
    if (routingResult.uiRouting) setRouting(routingResult.uiRouting);
    if (routingResult.error) {
      console.error("[routing]", routingResult.error instanceof Error ? routingResult.error.message : String(routingResult.error));
    }

    const controller = new AbortController();
    abortRef.current = controller;

    let turnUsage: Usage = emptyTurnUsage();
    const turnToolCalls: string[] = [];
    const turnStart = Date.now();
    const captureUsage = (u: Usage) => {
      turnUsage = accumulateTurnUsage(turnUsage, u);
      onUsage(u);
    };

    const store = ctxRef.current.sessionStore;
    const { runDir, projectContext, dynamicContext } = await prepareTurnContext({
      ctx: ctxRef.current,
      activeModel,
      turnCount: turnCountRef.current,
      refs: {
        historyRef,
        compressionStateRef,
        microCompactStateRef,
        memoryTrackerRef,
        frozenMemoryFilesRef,
        frozenMemorySignatureRef,
        frozenMemoryTurnRef,
        projectContextRef,
        loadedVeraContextPathsRef,
      },
    });

    const agentDefinitions = loadAgentDefinitions({ cwd: ctxRef.current.cwd });
    const {
      activeTools,
      activeSystem,
      activeExecutors,
      resolvedPrompt,
    } = prepareTurnSetup({
      ctx: ctxRef.current,
      intent: normalizePromptIntent(activeIntent),
      agentDefinitions,
      projectSystem: projectContext.system,
    });

    const toolCallHandler = buildToolCallHandler({
      ctxRef, store, userUuid, controller,
      activeAdapter, activeModel, activeProvider,
      activeTools, activeSystem, activeExecutors,
      agentDefinitions, loadedVeraContextPathsRef,
      turnToolCalls,
      captureUsage,
      setBlockingPrompt: openBlockingPrompt,
    });

    const usePlanMode = activeIntent !== null && shouldPlan(activeIntent);

    const writeAiTitleIfNeeded = (assistantText: string) => {
      maybeGenerateAiTitle({
        state: aiTitleStateRef.current,
        config: ctxRef.current.config.session?.ai_title,
        turnCount: turnCountRef.current,
        userPrompt: line,
        assistantText,
        toolCalls: turnToolCalls,
        activeAdapter,
        activeModel,
        buildAdapter: ctxRef.current.buildAdapter,
        writeAiTitle: (title) => store.writeAiTitle(title),
      });
    };

    const planExec = ctxRef.current.planExecutor ?? defaultPlanExecutor;
    await runPreparedTurn({
      line,
      usePlanMode,
      routingFailed,
      activeModel,
      activeProvider,
      userUuid,
      turnStartMs: turnStart,
      store,
      turnCountRef,
      historyRef,
      costRef,
      turnToolCalls,
      getTurnUsage: () => turnUsage,
      writeAiTitleIfNeeded,
      setMessages,
      dispatchUiEvent,
      onTextDelta,
      captureUsage,
      clearAbort: () => { abortRef.current = null; },
      plan: {
        executor: planExec,
        context: { adapter: activeAdapter, llmService: ctxRef.current.llmService, model: activeModel, tools: activeTools, system: activeSystem, maxTurns: resolvedPrompt?.maxTurns, signal: controller.signal, onToolCall: toolCallHandler, runDir, history: historyRef.current, ...dynamicContext },
        stepsRef: planStepsRef,
        stepTextRef: planStepTextRef,
        rafRef: planRafRef,
      },
      stream: {
        agentOptions: {
          adapter: activeAdapter,
          llmService: ctxRef.current.llmService,
          model: activeModel,
          tools: activeTools,
          system: activeSystem,
          maxTurns: resolvedPrompt?.maxTurns,
          history: historyRef.current,
          onUsage: captureUsage,
          signal: controller.signal,
          runDir,
          ...dynamicContext,
        },
        streamingBufferRef,
        rafRef,
        toolCallHandler: (name, args, onOutput) => toolCallHandler(name, args, onOutput),
        onThinkingDelta,
      },
    });
  }, [dispatchUiEvent, dispatchOverlay, openBlockingPrompt, enqueue, onTextDelta, onThinkingDelta, onUsage, exit, routing, usage, streamStatus, queue.items, clearQueue, removeQueued, updateQueued]);

  useEffect(() => {
    if (streamStatus !== "idle" || queue.items.length === 0) return;
    const next = dequeue();
    if (next) handleSubmit(next);
  }, [streamStatus, queue.items.length, dequeue, handleSubmit]);

  // ── Render ────────────────────────────────────────────────────────────────

  const handleScrollAdjust = useCallback(
    (delta: number) => setScrollOffset((prev) => prev + delta),
    [],
  );

  const { columns, rows } = dimensions;
  const reservedRows = 4 + queue.items.length;
  const availableHeight = Math.max(5, rows - reservedRows);

  const closeOverlay = () => dispatchOverlay({ type: "close" });
  const handleOpenExternalEditor = useCallback(async (request: { initialValue: string; cursor: number }) => {
    try {
      const result = await runExternalEditorRuntime(request);
      if (result.status === "not-configured") {
        setMessages((prev) => [...prev, { role: "assistant", content: "External editor is not configured. Set $VISUAL or $EDITOR." }]);
        return null;
      }
      if (result.status === "failed") {
        setMessages((prev) => [...prev, { role: "assistant", content: `External editor exited with code ${result.exitCode ?? "unknown"}.` }]);
        return null;
      }
      return result.result;
    } catch (err: unknown) {
      setMessages((prev) => [...prev, { role: "assistant", content: formatRuntimeError(err) }]);
      return null;
    }
  }, [setMessages]);

  if (overlay.type === "diff" || overlay.type === "sessionPicker" || overlay.type === "providerPicker" || overlay.type === "modelPicker") {
    debugLog(`[App] rendering full-screen overlay: ${overlay.type}`);
    return (
      <OverlayHost
        overlay={overlay}
        ctx={ctx}
        ctxRef={ctxRef}
        columns={columns}
        rows={dimensions.rows}
        setMessages={setMessages}
        onClose={closeOverlay}
      />
    );
  }

  return (
    <Box flexDirection="column">
      <WelcomeScreen
        cwd={ctx.cwd}
        routing={routing}
        columns={columns}
        value={inputValue}
        onChange={setInputValue}
        onSubmit={handleSubmit}
        onExit={exit}
        showInput={messages.length === 0}
        pathCandidates={pathCandidates}
        onOpenExternalEditor={handleOpenExternalEditor}
      />
      {messages.length > 0 && (
        <>
          <ConversationPanel messages={messages} width={columns} availableHeight={availableHeight} scrollOffset={scrollOffset} expandToolOutput={expandToolOutput} onScrollAdjust={handleScrollAdjust} />
          <ActivityLane turn={activeTurn} />
          <Box><Text color={theme.textSubtle}>{"─".repeat(columns)}</Text></Box>
          <StatusBar status={streamStatus} inputTokens={activeTurn.inputTokens} outputTokens={activeTurn.outputTokens} pendingCount={queue.items.length} scrollOffset={scrollOffset} expandToolOutput={expandToolOutput} />
          {queue.items.map((msg, i) => (
            <Box key={i}>
              <Text color={theme.warning}>{`⏎ ${i + 1}. `}</Text>
              <Text color={theme.brandShimmer} wrap="truncate-end">{msg}</Text>
            </Box>
          ))}
          <OverlayHost
            overlay={overlay}
            ctx={ctx}
            ctxRef={ctxRef}
            columns={columns}
            rows={dimensions.rows}
            setMessages={setMessages}
            onClose={closeOverlay}
          >
            <>
              {recentSummary && (
                <Box marginBottom={1}>
                  <Text color={theme.warning}>{"  " + formatRecentLine(recentSummary)}</Text>
                </Box>
              )}
              <InputBar
                value={inputValue}
                onChange={(v) => { dismissRecent(); setInputValue(v); }}
                onSubmit={handleSubmit} onExit={exit} onCancel={handleCancel}
                isStreaming={streamStatus !== "idle"} history={inputHistoryRef.current}
                onScrollUp={handleScrollUp} onScrollDown={handleScrollDown}
                onToggleToolOutput={() => setExpandToolOutput((v) => !v)}
                pathCandidates={pathCandidates}
                onOpenExternalEditor={handleOpenExternalEditor}
              />
            </>
          </OverlayHost>
        </>
      )}
    </Box>
  );
}
