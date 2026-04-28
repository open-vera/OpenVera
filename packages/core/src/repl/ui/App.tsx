import { useApp, useStdout, Box, Text } from "ink";
import { useState, useRef, useEffect, useCallback } from "react";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadavg } from "node:os";
import { streamAgent } from "../../agent/loop.js";
import {
  SUBAGENT_TOOL_NAME,
  buildSubagentToolSchema,
  loadAgentDefinitions,
} from "../../agent/subagent.js";
import { resolveModel, shouldPlan } from "../../intent/classifier.js";
import type { IntentResult } from "../../intent/classifier.js";
import { defaultPlanExecutor } from "../../plan/index.js";
import type { PlanStepUI } from "../../plan/index.js";
import { handleCommand } from "../commands/index.js";
import { accumulateCost, emptyAccumulatedCost, generateSessionTitle, SessionStore } from "../../session/index.js";
import type { AccumulatedCost } from "../../session/index.js";
import type { ReplContext } from "../context.js";
import type { Usage, Message } from "../../types/index.js";
import { MemoryTracker } from "../../memory/index.js";
import type { MemoryFile } from "../../memory/index.js";
import { loadProjectContext } from "../../project-context/index.js";
import type { ProjectContext } from "../../project-context/index.js";
import {
  createCompressionState,
  createMicroCompactState,
  getModelContextLimit,
} from "../../context/index.js";
import type { CompressionState, MicroCompactState } from "../../context/index.js";
import { ConversationPanel } from "./ConversationPanel.js";
import { DiffDialog } from "./DiffDialog.js";
import { InputBar } from "./InputBar.js";
import { SessionPicker } from "./SessionPicker.js";
import { StatusBar } from "./StatusBar.js";
import { WelcomeScreen } from "./WelcomeScreen.js";
import type { ChatMessage, RoutingInfo, StreamStatus, TokenUsage, ToolUse } from "./types.js";
import { theme } from "./theme.js";
import { resumedVisibleMessages } from "./utils.js";
import { useSessionLifecycle } from "./hooks/useSessionLifecycle.js";
import { useStreamingHelpers } from "./hooks/useStreamingHelpers.js";
import { buildToolCallHandler } from "./hooks/useToolCallHandler.js";
import { buildPlanEventHandler } from "./hooks/usePlanRunner.js";

function formatError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes("apiKey") || msg.includes("authToken") || msg.includes("authentication") || msg.includes("API key")) {
    return [
      "No API key configured.",
      "  → Set it in .vera/settings.json:  providers.<name>.api_key",
      "  → Or via env var:                 ANTHROPIC_API_KEY=sk-...",
    ].join("\n");
  }
  if (msg.includes("rate_limit") || msg.includes("429")) {
    return "Rate limited — wait a moment and try again.";
  }
  if (msg.includes("ECONNREFUSED") || msg.includes("ENOTFOUND") || msg.includes("fetch")) {
    return "Network error — check your connection or base_url in .vera/settings.json.";
  }
  return `Error: ${msg}`;
}

async function captureCommand(cmd: string, args: string[], ctx: ReplContext): Promise<string> {
  const lines: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...a: unknown[]) => lines.push(a.map(String).join(" "));
  console.error = (...a: unknown[]) => lines.push(a.map(String).join(" "));
  try {
    await handleCommand(cmd, args, ctx);
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
  return lines.join("\n") || `Unknown command: /${cmd}`;
}

const MEMORY_FILE_CHAR_LIMIT = 8_000;
const MEMORY_TOTAL_CHAR_LIMIT = 24_000;
const MEMORY_REFRESH_TURNS = 5;
const CONTEXT_TARGET_UTILIZATION = 0.85;
const COMPRESSION_TRIGGER_UTILIZATION = 0.78;

function memoryInventorySignature(memories: MemoryFile[]): string {
  return memories
    .map((m) => `${m.path}:${Math.floor(m.mtimeMs)}`)
    .sort()
    .join("|");
}

function buildMemoryPreamble(memories: MemoryFile[]): string {
  if (memories.length === 0) return "";
  const blocks: string[] = [];
  let remaining = MEMORY_TOTAL_CHAR_LIMIT;
  for (const memory of memories) {
    if (remaining <= 0) break;
    try {
      const raw = readFileSync(memory.path, "utf8");
      const body = raw.slice(0, Math.min(MEMORY_FILE_CHAR_LIMIT, remaining));
      const truncated = raw.length > body.length ? "\n[truncated]" : "";
      blocks.push(
        [`### ${memory.filename}`, memory.description ? `description: ${memory.description}` : "", memory.type ? `type: ${memory.type}` : "", body + truncated]
          .filter(Boolean).join("\n"),
      );
      remaining -= body.length;
    } catch {
      // Memory files are opportunistic context; ignore files that disappeared.
    }
  }
  if (blocks.length === 0) return "";
  return ["", "Relevant memory files selected for this turn:", blocks.join("\n\n")].join("\n");
}

function mergeSystemPrompts(...parts: Array<string | undefined>): string {
  return parts.map((p) => p?.trim()).filter(Boolean).join("\n\n");
}

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
  const hasCustomTitleRef = useRef(false);
  const aiTitleGeneratedRef = useRef(false);
  const aiTitleAttemptsRef = useRef(0);
  const inputHistoryRef = useRef<string[]>([]);
  const costRef = useRef<AccumulatedCost>(emptyAccumulatedCost());
  const turnCountRef = useRef(0);
  const latestInputTokensRef = useRef(0);
  const pendingQueueRef = useRef<string[]>([]);
  const [pendingQueue, setPendingQueue] = useState<string[]>([]);
  const planStepTextRef = useRef("");
  const planRafRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const planStepsRef = useRef<PlanStepUI[]>([]);

  const syncQueue = useCallback(() => setPendingQueue([...pendingQueueRef.current]), []);

  const [inputValue, setInputValue] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streamStatus, setStreamStatus] = useState<StreamStatus>("idle");
  const [scrollOffset, setScrollOffset] = useState(0);
  const [expandToolOutput, setExpandToolOutput] = useState(false);
  const isFollowingRef = useRef(true);
  const [diffOpen, setDiffOpen] = useState(false);
  const [sessionPickerOpen, setSessionPickerOpen] = useState(false);
  const [pathConfirm, setPathConfirm] = useState<{
    message: string;
    allowDir: string;
    resolve: (approved: boolean) => void;
  } | null>(null);
  const [usage, setUsage] = useState<TokenUsage>({
    inputTotal: 0, outputTotal: 0, cacheWriteTotal: 0, cacheReadTotal: 0, costUsd: 0,
  });
  const [currentOutputTokens, setCurrentOutputTokens] = useState(0);
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
    setMessages, setUsage, setSessionPickerOpen,
  });

  // ── Streaming helpers ────────────────────────────────────────────────────────

  const { onTextDelta, onUsage, handleCancel, handleScrollUp, handleScrollDown } = useStreamingHelpers({
    streamingBufferRef, rafRef, abortRef,
    costRef, latestInputTokensRef, pendingQueueRef,
    routing, inputValue, streamStatus, rows: dimensions.rows,
    setMessages, setUsage, setCurrentOutputTokens,
    setScrollOffset, setInputValue, syncQueue,
  });

  // ── Main submit handler ──────────────────────────────────────────────────────

  const handleSubmit = useCallback(async (line: string) => {
    if (streamStatus !== "idle") {
      const trimmed = line.trim();
      if (trimmed) { pendingQueueRef.current.push(trimmed); syncQueue(); }
      return;
    }

    if (!line.startsWith("/")) {
      setMessages((prev) => [...prev, { role: "user", content: line }]);
      inputHistoryRef.current = [...inputHistoryRef.current, line];
      isFollowingRef.current = true;
      setScrollOffset(0);
    }

    // ── Commands ──────────────────────────────────────────────────────────────

    if (line.startsWith("/")) {
      const [cmd, ...args] = line.slice(1).split(/\s+/);
      if (cmd === "exit" || cmd === "quit") {
        ctxRef.current.sessionStore.writeEnd(
          costRef.current.totalUsage, costRef.current.totalUsd,
          turnCountRef.current, inputHistoryRef.current.at(-1),
        );
        exit();
        return;
      }
      if (cmd === "diff") { setDiffOpen(true); return; }
      if (cmd === "title") { hasCustomTitleRef.current = true; }

      setMessages((prev) => [...prev, { role: "user", content: line }]);
      if (cmd === "status") {
        setMessages((prev) => {
          const r = routing;
          const u = usage;
          const ctxMax = getModelContextLimit(r.model);
          const ctxUsed = latestInputTokensRef.current;
          const ctxPct = ctxMax > 0 ? ((ctxUsed / ctxMax) * 100).toFixed(1) : "0.0";
          const ctxBar = ctxUsed > 0
            ? `${ctxUsed.toLocaleString()} / ${ctxMax.toLocaleString()} (${ctxPct}%)`
            : `unknown / ${ctxMax.toLocaleString()}`;
          const byModelLines = Object.entries(costRef.current.byModel).map(([m, rec]) => {
            const cacheW = rec.usage.cache_creation_input_tokens;
            const cacheR = rec.usage.cache_read_input_tokens;
            const cachePart = (cacheW || cacheR) ? ` | cache w:${(cacheW ?? 0).toLocaleString()} r:${(cacheR ?? 0).toLocaleString()}` : "";
            return `  ${m}: in ${rec.usage.input_tokens.toLocaleString()} / out ${rec.usage.output_tokens.toLocaleString()}${cachePart} = $${rec.costUsd.toFixed(4)}`;
          });
          const mem = process.memoryUsage();
          const load = loadavg();
          const parts = [
            `Provider: ${r.provider}`, `Model:    ${r.model}`, `Turns:    ${turnCountRef.current}`,
            `Context:  ${ctxBar}`, `Tokens:   in ${u.inputTotal.toLocaleString()} / out ${u.outputTotal.toLocaleString()}`,
            ...(u.cacheWriteTotal || u.cacheReadTotal ? [`Cache:    write ${u.cacheWriteTotal.toLocaleString()} / read ${u.cacheReadTotal.toLocaleString()}`] : []),
            `Cost:     $${u.costUsd.toFixed(4)}`,
            ...(byModelLines.length ? ["\nBy model:", ...byModelLines] : []),
            `\nMemory:   RSS ${(mem.rss / 1024 / 1024).toFixed(0)} MB / heap ${(mem.heapUsed / 1024 / 1024).toFixed(0)}/${(mem.heapTotal / 1024 / 1024).toFixed(0)} MB`,
            `CPU load: ${load.map((l) => l.toFixed(2)).join(" / ")} (1m/5m/15m)`,
          ];
          if (r.intent) parts.push(`\nIntent:   L${r.intent.level} · ${r.intent.domain} → ${r.provider}`);
          return [...prev, { role: "assistant", content: parts.join("\n") }];
        });
        return;
      }
      const output = await captureCommand(cmd!, args, ctxRef.current);
      setMessages((prev) => [...prev, { role: "assistant", content: output }]);
      return;
    }

    // ── Turn setup ────────────────────────────────────────────────────────────

    const userUuid = ctxRef.current.sessionStore.writeUser(line);

    let activeAdapter = ctxRef.current.adapter;
    let activeModel = ctxRef.current.model;
    let activeProvider = ctxRef.current.config.default_provider ?? "anthropic";
    let routingFailed = false;
    let activeIntent: IntentResult | null = null;
    const routingCfg = ctxRef.current.config.routing;
    if (routingCfg?.enabled) {
      setStreamStatus("thinking");
      const classifierTarget = routingCfg.classifier;
      const classifierAdapter = classifierTarget ? ctxRef.current.buildAdapter(classifierTarget.provider) : activeAdapter;
      const classifierModel = classifierTarget?.model ?? "claude-haiku-4-5";
      try {
        const classifierProvider = classifierTarget?.provider ?? ctxRef.current.config.default_provider ?? "anthropic";
        const { model: routed, provider: routedProvider, intent } = await resolveModel(
          line, classifierAdapter, classifierModel, routingCfg,
          ctxRef.current.config.default_provider ?? "anthropic", ctxRef.current.model,
          (u) => {
            const updated = accumulateCost(costRef.current, u, classifierModel, classifierProvider);
            costRef.current = updated;
            setUsage((prev) => ({ ...prev, inputTotal: prev.inputTotal + (u.input_tokens ?? 0), outputTotal: prev.outputTotal + (u.output_tokens ?? 0), costUsd: updated.totalUsd }));
          },
        );
        if (routedProvider) { activeAdapter = ctxRef.current.buildAdapter(routedProvider); activeProvider = routedProvider; }
        activeModel = routed;
        activeIntent = intent;
        routingFailed = intent === null;
        setRouting({ provider: routedProvider ?? ctxRef.current.config.default_provider ?? "anthropic", model: routed, intent });
      } catch (err) {
        routingFailed = true;
        console.error("[routing]", err instanceof Error ? err.message : String(err));
      }
    }

    setCurrentOutputTokens(0);
    const controller = new AbortController();
    abortRef.current = controller;

    let turnUsage: Usage = { input_tokens: 0, output_tokens: 0 };
    const turnToolCalls: string[] = [];
    const turnStart = Date.now();
    const captureUsage = (u: Usage) => {
      turnUsage = {
        input_tokens: turnUsage.input_tokens + u.input_tokens,
        output_tokens: turnUsage.output_tokens + u.output_tokens,
        cache_creation_input_tokens: (turnUsage.cache_creation_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
        cache_read_input_tokens: (turnUsage.cache_read_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
      };
      onUsage(u);
    };

    const store = ctxRef.current.sessionStore;
    const runDir = dirname(store.filePath);
    if (projectContextRef.current === null) {
      projectContextRef.current = loadProjectContext({ cwd: ctxRef.current.cwd });
      loadedVeraContextPathsRef.current = new Set(projectContextRef.current.files.map((f) => f.path));
    }
    if (memoryTrackerRef.current === null) {
      memoryTrackerRef.current = new MemoryTracker({ memoryDir: join(runDir, "memory") });
    }
    const scannedMemoryFiles = await memoryTrackerRef.current.scan();
    const memorySignature = memoryInventorySignature(scannedMemoryFiles);
    const shouldRefreshMemory =
      frozenMemoryFilesRef.current.length === 0 ||
      turnCountRef.current - frozenMemoryTurnRef.current >= MEMORY_REFRESH_TURNS ||
      memorySignature !== frozenMemorySignatureRef.current;
    if (shouldRefreshMemory) {
      frozenMemoryFilesRef.current = memoryTrackerRef.current.selectForInjection(scannedMemoryFiles);
      frozenMemorySignatureRef.current = memorySignature;
      frozenMemoryTurnRef.current = turnCountRef.current;
    }

    const modelContextLimit = getModelContextLimit(activeModel);
    const dynamicContext = {
      contextOptions: { maxTokens: modelContextLimit, targetUtilization: CONTEXT_TARGET_UTILIZATION, keepRecentTurns: 6 },
      compressionOptions: { enabled: true, triggerTokens: Math.floor(modelContextLimit * COMPRESSION_TRIGGER_UTILIZATION), keepRecentTurns: 6, model: activeModel },
      microCompactOptions: { enabled: true, gapThresholdMinutes: 60, keepRecent: 5 },
      compressionState: compressionStateRef.current,
      microCompactState: microCompactStateRef.current,
      memoryTracker: memoryTrackerRef.current,
      scannedMemoryFiles: frozenMemoryFilesRef.current,
      onMemorySelected: buildMemoryPreamble,
      onContextUpdate: (nextHistory: Message[], update: { compressionState: typeof compressionStateRef.current | null; microCompactState: typeof microCompactStateRef.current | null }) => {
        historyRef.current = [...nextHistory];
        if (update.compressionState) compressionStateRef.current = update.compressionState;
        if (update.microCompactState) microCompactStateRef.current = update.microCompactState;
      },
    };

    const skillBundle = ctxRef.current.resolveSkillBundle?.({ domain: activeIntent?.domain ?? "chat", level: activeIntent?.level ?? 0, needs_tools: activeIntent?.needs_tools ?? false });
    const registryTools = ctxRef.current.tools;
    const skillExtras = (skillBundle?.tools ?? []).filter((t) => !registryTools.some((r) => r.name === t.name));
    const activeToolsWithoutAgent = skillExtras.length ? [...registryTools, ...skillExtras] : registryTools;
    const agentDefinitions = loadAgentDefinitions({ cwd: ctxRef.current.cwd });
    const agentToolSchema = buildSubagentToolSchema(agentDefinitions);
    const activeTools = activeToolsWithoutAgent.some((t) => t.name === SUBAGENT_TOOL_NAME)
      ? activeToolsWithoutAgent
      : [...activeToolsWithoutAgent, agentToolSchema];
    const resolvedPrompt = ctxRef.current.promptStore.resolve({ domain: activeIntent?.domain ?? "chat", level: activeIntent?.level ?? 0, needs_tools: activeIntent?.needs_tools ?? false });
    const baseSystem = resolvedPrompt?.system ?? "You are Vera, a helpful assistant.";
    const activeSystem = mergeSystemPrompts(skillBundle?.system ?? baseSystem, projectContextRef.current?.system);
    const activeExecutors = skillBundle?.executors;

    const toolCallHandler = buildToolCallHandler({
      ctxRef, store, userUuid, controller,
      activeAdapter, activeModel, activeProvider,
      activeTools, activeSystem, activeExecutors,
      agentDefinitions, loadedVeraContextPathsRef,
      turnToolCalls, captureUsage, setPathConfirm,
    });

    const usePlanMode = activeIntent !== null && shouldPlan(activeIntent);

    const writeAiTitleIfNeeded = (assistantText: string) => {
      const aiTitleConfig = ctxRef.current.config.session?.ai_title;
      if (aiTitleConfig?.enabled === false) return;
      if (hasCustomTitleRef.current || aiTitleGeneratedRef.current || aiTitleAttemptsRef.current >= 2) return;
      if (turnCountRef.current > 1) return;
      aiTitleGeneratedRef.current = true;
      aiTitleAttemptsRef.current += 1;
      const toolsSummary = turnToolCalls.length ? `Tools used: ${[...new Set(turnToolCalls)].slice(0, 8).join(", ")}` : undefined;
      void generateSessionTitle({
        adapter: aiTitleConfig?.provider ? ctxRef.current.buildAdapter(aiTitleConfig.provider) : activeAdapter,
        model: aiTitleConfig?.model ?? activeModel,
        userPrompt: line,
        assistantText: assistantText.trim() || toolsSummary,
      }).then((title) => {
        if (title && !hasCustomTitleRef.current) store.writeAiTitle(title);
        if (!title) aiTitleGeneratedRef.current = false;
      }).catch(() => { aiTitleGeneratedRef.current = false; });
    };

    // ── Plan mode ─────────────────────────────────────────────────────────────

    if (usePlanMode) {
      planStepsRef.current = [];
      planStepTextRef.current = "";
      setMessages((prev) => {
        const prefix: ChatMessage[] = routingFailed ? [{ role: "assistant", content: "⚠ routing failed — using default model" }] : [];
        return [...prev, ...prefix, { role: "assistant", content: "", streaming: true, planMode: true, planSteps: [], activeStepIndex: -1 }];
      });
      setStreamStatus("planning");

      const handlePlanEvent = buildPlanEventHandler({ setMessages, setStreamStatus, planStepsRef, planStepTextRef, planRafRef });
      const planExec = ctxRef.current.planExecutor ?? defaultPlanExecutor;

      try {
        await planExec(
          line,
          { adapter: activeAdapter, model: activeModel, tools: activeTools, system: activeSystem, maxTurns: resolvedPrompt?.maxTurns, signal: controller.signal, onToolCall: toolCallHandler, runDir, history: historyRef.current, ...dynamicContext },
          handlePlanEvent,
          captureUsage,
        );
        const summaryLines = planStepsRef.current.map((s, i) => `步骤 ${i + 1}：${s.description}\n${s.content}`);
        const fullText = summaryLines.join("\n\n");
        store.writeAssistant({ parentUuid: userUuid, content: fullText, model: activeModel, provider: activeProvider, stopReason: "end_turn", usage: turnUsage, turn: turnCountRef.current + 1, latencyMs: Date.now() - turnStart, toolCalls: turnToolCalls, status: "ok" });
        historyRef.current = [...historyRef.current, { role: "user", content: line } satisfies Message, { role: "assistant", content: fullText } satisfies Message];
        writeAiTitleIfNeeded(fullText);
        turnCountRef.current += 1;
      } catch (err) {
        if (planRafRef.current !== null) { clearTimeout(planRafRef.current); planRafRef.current = null; }
        const isAbort = err instanceof Error && (err.name === "AbortError" || err.message.includes("aborted"));
        if (!isAbort) {
          setMessages((prev) => {
            const last = prev[prev.length - 1];
            if (!last?.planMode) return prev;
            return [...prev.slice(0, -1), { ...last, content: formatError(err), streaming: false, planMode: false }];
          });
        } else {
          setMessages((prev) => {
            const last = prev[prev.length - 1];
            if (!last?.planMode) return prev;
            return [...prev.slice(0, -1), { ...last, streaming: false }];
          });
        }
      } finally {
        abortRef.current = null;
        setStreamStatus("idle");
      }
      return;
    }

    // ── Stream mode ───────────────────────────────────────────────────────────

    setMessages((prev) => {
      const base: ChatMessage = { role: "assistant", content: "", streaming: true };
      const prefix: ChatMessage[] = routingFailed ? [{ role: "assistant", content: "⚠ routing failed — using default model" }] : [];
      return [...prev, ...prefix, base];
    });
    setStreamStatus("streaming");
    streamingBufferRef.current = "";

    try {
      const fullText = await streamAgent(
        line,
        {
          adapter: activeAdapter, model: activeModel, tools: activeTools, system: activeSystem,
          maxTurns: resolvedPrompt?.maxTurns, history: historyRef.current, onUsage: captureUsage,
          signal: controller.signal, runDir, ...dynamicContext,
          onToolCall: async (name, args) => {
            if (rafRef.current !== null) { clearTimeout(rafRef.current); rafRef.current = null; }
            const preface = streamingBufferRef.current.trim();
            streamingBufferRef.current = "";
            setMessages((prev) => {
              const last = prev[prev.length - 1];
              if (!last?.streaming || !last.content) return prev;
              return [...prev.slice(0, -1), { ...last, content: "" }];
            });
            const toolResult = await toolCallHandler(name, args as Record<string, unknown>);
            const toolUse: ToolUse = { name, args: args as Record<string, unknown>, result: toolResult, ...(preface ? { preface } : {}) };
            setMessages((prev) => {
              const last = prev[prev.length - 1];
              if (!last?.streaming) return prev;
              return [...prev.slice(0, -1), { ...last, toolUses: [...(last.toolUses ?? []), toolUse] }];
            });
            return toolResult.content;
          },
        },
        onTextDelta,
      );

      if (rafRef.current !== null) { clearTimeout(rafRef.current); rafRef.current = null; }
      streamingBufferRef.current = fullText;
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (!last?.streaming) return prev;
        return [...prev.slice(0, -1), { ...last, content: fullText, streaming: false }];
      });
      writeAiTitleIfNeeded(fullText);
      store.writeAssistant({ parentUuid: userUuid, content: fullText, model: activeModel, provider: activeProvider, stopReason: "end_turn", usage: turnUsage, turn: turnCountRef.current + 1, latencyMs: Date.now() - turnStart, toolCalls: turnToolCalls, status: "ok" });
      turnCountRef.current += 1;
    } catch (err) {
      if (rafRef.current !== null) { clearTimeout(rafRef.current); rafRef.current = null; }
      const isAbort = err instanceof Error && (err.name === "AbortError" || err.message.includes("aborted"));
      const errMsg = isAbort ? "Cancelled." : formatError(err);
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (last?.streaming) return [...prev.slice(0, -1), { role: "assistant", content: last.content || errMsg, streaming: false }];
        return [...prev, { role: "assistant", content: errMsg }];
      });
      if (!isAbort) {
        store.writeAssistant({ parentUuid: userUuid, content: errMsg, model: activeModel, provider: activeProvider, stopReason: "end_turn", usage: turnUsage, turn: turnCountRef.current + 1, latencyMs: Date.now() - turnStart, toolCalls: turnToolCalls, status: "error" });
      }
      store.writeEnd(costRef.current.totalUsage, costRef.current.totalUsd, turnCountRef.current, line);
    } finally {
      abortRef.current = null;
      setStreamStatus("idle");
    }
  }, [onTextDelta, onUsage, exit, routing, usage, streamStatus]);

  useEffect(() => {
    if (streamStatus === "idle" && pendingQueueRef.current.length > 0) {
      const next = pendingQueueRef.current.shift()!;
      syncQueue();
      handleSubmit(next);
    }
  }, [streamStatus, handleSubmit]);

  // ── Render ────────────────────────────────────────────────────────────────

  const { columns, rows } = dimensions;
  const reservedRows = 4 + pendingQueue.length;
  const availableHeight = Math.max(5, rows - reservedRows);

  if (diffOpen) {
    return <DiffDialog cwd={ctx.cwd} width={columns} height={dimensions.rows} onClose={() => setDiffOpen(false)} />;
  }

  if (sessionPickerOpen) {
    const sessionPage = SessionStore.listSessionsPaged({ cwd: ctx.cwd, limit: 30 });
    return (
      <Box flexDirection="column">
        <SessionPicker
          cwd={ctx.cwd}
          initialSessions={sessionPage.sessions}
          initialNextOffset={sessionPage.nextOffset}
          width={columns}
          onSelect={(sessionId) => {
            setSessionPickerOpen(false);
            try {
              const loaded = SessionStore.loadSession(sessionId, ctx.cwd);
              const preview = SessionStore.loadTranscriptPreview(sessionId, ctx.cwd);
              ctxRef.current.onResume!(loaded);
              setMessages((prev) => [...prev, ...resumedVisibleMessages(sessionId, preview, loaded)]);
            } catch (err) {
              setMessages((prev) => [...prev, { role: "assistant", content: `Failed to load session: ${err instanceof Error ? err.message : String(err)}` }]);
            }
          }}
          onClose={() => setSessionPickerOpen(false)}
        />
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <WelcomeScreen cwd={ctx.cwd} routing={routing} columns={columns} value={inputValue} onChange={setInputValue} onSubmit={handleSubmit} onExit={exit} showInput={messages.length === 0} />
      {messages.length > 0 && (
        <>
          <ConversationPanel messages={messages} width={columns} availableHeight={availableHeight} scrollOffset={scrollOffset} expandToolOutput={expandToolOutput} />
          <Box><Text color={theme.textSubtle}>{"─".repeat(columns)}</Text></Box>
          <StatusBar status={streamStatus} outputTokens={currentOutputTokens} pendingCount={pendingQueue.length} scrollOffset={scrollOffset} expandToolOutput={expandToolOutput} />
          {pendingQueue.map((msg, i) => (
            <Box key={i}>
              <Text color={theme.warning}>{"⏎ "}</Text>
              <Text color={theme.brandShimmer} wrap="truncate-end">{msg}</Text>
            </Box>
          ))}
          {pathConfirm ? (
            <Box flexDirection="column">
              <Text color={theme.warning}>⚠ {pathConfirm.message}</Text>
              <Text color={theme.warning}>Allow? [y/N] </Text>
              <InputBar
                value={inputValue} onChange={setInputValue}
                onSubmit={(line) => { const approved = line.trim().toLowerCase() === "y"; setInputValue(""); pathConfirm.resolve(approved); }}
                onExit={exit} onCancel={() => { setInputValue(""); pathConfirm.resolve(false); }}
                isStreaming={false} history={[]}
                onScrollUp={handleScrollUp} onScrollDown={handleScrollDown}
                onToggleToolOutput={() => setExpandToolOutput((v) => !v)}
              />
            </Box>
          ) : (
            <InputBar
              value={inputValue} onChange={setInputValue} onSubmit={handleSubmit} onExit={exit} onCancel={handleCancel}
              isStreaming={streamStatus !== "idle"} history={inputHistoryRef.current}
              onScrollUp={handleScrollUp} onScrollDown={handleScrollDown}
              onToggleToolOutput={() => setExpandToolOutput((v) => !v)}
            />
          )}
        </>
      )}
    </Box>
  );
}
