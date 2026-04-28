import { useApp, useStdout, Box, Text } from "ink";
import { useState, useRef, useEffect, useCallback } from "react";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { streamAgent } from "../../agent/loop.js";
import {
  SUBAGENT_TOOL_NAME,
  buildSubagentToolSchema,
  loadAgentDefinitions,
  runSubagentTool,
} from "../../agent/subagent.js";
import { resolveModel, shouldPlan } from "../../intent/classifier.js";
import type { IntentResult } from "../../intent/classifier.js";
import { defaultPlanExecutor } from "../../plan/index.js";
import type { PlanEvent, PlanStepUI } from "../../plan/index.js";
import { handleCommand } from "../commands/index.js";
import { accumulateCost, emptyAccumulatedCost, generateSessionTitle, SessionStore } from "../../session/index.js";
import type { AccumulatedCost } from "../../session/index.js";
import type { ReplContext } from "../context.js";
import type { Usage, Message } from "../../types/index.js";
import type { ToolResult } from "../../tools/types.js";
import { MemoryTracker } from "../../memory/index.js";
import type { MemoryFile } from "../../memory/index.js";
import {
  loadNestedProjectContext,
  loadProjectContext,
} from "../../project-context/index.js";
import type { ProjectContext } from "../../project-context/index.js";
import {
  createCompressionState,
  createMicroCompactState,
  getModelContextLimit,
} from "../../context/index.js";
import type {
  CompressionState,
  MicroCompactState,
} from "../../context/index.js";
import { ConversationPanel } from "./ConversationPanel.js";
import { DiffDialog } from "./DiffDialog.js";
import { InputBar } from "./InputBar.js";
import { SessionPicker } from "./SessionPicker.js";
import { StatusBar } from "./StatusBar.js";
import { WelcomeScreen } from "./WelcomeScreen.js";
import { resolveResumeWorkspace } from "../workspace.js";
import type { ChatMessage, RoutingInfo, StreamStatus, TokenUsage, ToolUse } from "./types.js";

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
        [
          `### ${memory.filename}`,
          memory.description ? `description: ${memory.description}` : "",
          memory.type ? `type: ${memory.type}` : "",
          body + truncated,
        ].filter(Boolean).join("\n"),
      );
      remaining -= body.length;
    } catch {
      // Memory files are opportunistic context; ignore files that disappeared.
    }
  }

  if (blocks.length === 0) return "";
  return [
    "",
    "Relevant memory files selected for this turn:",
    blocks.join("\n\n"),
  ].join("\n");
}

function mergeSystemPrompts(...parts: Array<string | undefined>): string {
  return parts.map((p) => p?.trim()).filter(Boolean).join("\n\n");
}

function maybeWriteGitBranch(store: SessionStore, cwd: string): void {
  try {
    const branch = readFileSync(join(cwd, ".git", "HEAD"), "utf8")
      .trim()
      .replace(/^ref: refs\/heads\//, "");
    if (branch) store.writeGitBranch(branch);
  } catch {
    // Git metadata is opportunistic; keep session startup fast and quiet.
  }
}

function previewToChatMessages(preview: ReturnType<typeof SessionStore.loadTranscriptPreview>): ChatMessage[] {
  return preview.messages.map((message) => ({
    role: message.role,
    content: message.content,
    ...(message.toolUses?.length
      ? {
          toolUses: message.toolUses.map((toolUse) => ({
            name: toolUse.name,
            args: toolUse.args,
            result: {
              ok: toolUse.result.ok,
              content: toolUse.result.content,
            },
          })),
        }
      : {}),
  }));
}

function resumedVisibleMessages(sessionId: string, preview: ReturnType<typeof SessionStore.loadTranscriptPreview>, loaded: { turnCount: number; totalCostUsd: number }): ChatMessage[] {
  const recentMessages = previewToChatMessages(preview).slice(-12);
  return [
    {
      role: "assistant",
      content: `Resumed session ${sessionId.slice(0, 8)} — showing the last ${recentMessages.length} messages from ${loaded.turnCount} turns, $${loaded.totalCostUsd.toFixed(4)} spent.`,
    },
    ...recentMessages,
  ];
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
    const onResize = () =>
      setDimensions({ columns: stdout.columns ?? 80, rows: stdout.rows ?? 24 });
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
  const pendingQueueRef = useRef<string[]>([]);
  const [pendingQueue, setPendingQueue] = useState<string[]>([]);
  // Plan mode refs
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
  // Pending path-confirm request — blocks agent until user responds y/n
  const [pathConfirm, setPathConfirm] = useState<{
    message: string;
    allowDir: string;
    resolve: (approved: boolean) => void;
  } | null>(null);
  const [usage, setUsage] = useState<TokenUsage>({
    inputTotal: 0,
    outputTotal: 0,
    cacheWriteTotal: 0,
    cacheReadTotal: 0,
    costUsd: 0,
  });
  const [currentOutputTokens, setCurrentOutputTokens] = useState(0);
  const [routing, setRouting] = useState<RoutingInfo>({
    provider: ctx.config.default_provider ?? "anthropic",
    model: ctx.model,
    intent: null,
  });

  // ── Session init ────────────────────────────────────────────────────────────

  useEffect(() => {
    // Expose onResume for /resume command
    ctxRef.current.onResume = (loaded) => {
      const workspace = resolveResumeWorkspace(loaded, ctxRef.current.cwd);
      const nextCwd = workspace.cwd;
      const resumedStore = new SessionStore({
        sessionId: loaded.sessionId,
        cwd: loaded.cwd,
      });
      ctxRef.current.onSwitchWorkspace?.(nextCwd, resumedStore);
      ctxRef.current.sessionStore = resumedStore;
      historyRef.current = loaded.history;
      compressionStateRef.current = createCompressionState();
      microCompactStateRef.current = createMicroCompactState();
      memoryTrackerRef.current = null;
      frozenMemoryFilesRef.current = [];
      frozenMemorySignatureRef.current = "";
      frozenMemoryTurnRef.current = -MEMORY_REFRESH_TURNS;
      loadedVeraContextPathsRef.current = new Set(
        projectContextRef.current?.files.map((file) => file.path) ?? []
      );
      costRef.current = {
        totalUsd: loaded.totalCostUsd,
        byModel: {},
        totalUsage: loaded.totalUsage,
      };
      turnCountRef.current = loaded.turnCount;
      setUsage((prev) => ({
        ...prev,
        inputTotal: loaded.totalUsage.input_tokens,
        outputTotal: loaded.totalUsage.output_tokens,
        cacheWriteTotal: loaded.totalUsage.cache_creation_input_tokens ?? 0,
        cacheReadTotal: loaded.totalUsage.cache_read_input_tokens ?? 0,
        costUsd: loaded.totalCostUsd,
      }));
      // Write a new session_start to mark re-entry
      resumedStore.writeStart(
        loaded.model || ctxRef.current.model,
        loaded.provider || (ctxRef.current.config.default_provider ?? "anthropic")
      );
      maybeWriteGitBranch(resumedStore, ctxRef.current.cwd);
      if (workspace.warning) {
        console.log(workspace.warning);
      }
    };

    // Expose session picker for /resume command (no args)
    ctxRef.current.onShowSessionPicker = () => setSessionPickerOpen(true);
    ctxRef.current.onSwitchWorkspace = (cwd, sessionStore) => {
      ctxRef.current.cwd = cwd;
      const bundle = ctxRef.current.createToolRegistry?.({ cwd, sessionStore });
      if (bundle) {
        ctxRef.current.registry = bundle.registry;
        ctxRef.current.security = bundle.security;
        ctxRef.current.tools = bundle.registry.getSchemas();
      }
      projectContextRef.current = null;
      loadedVeraContextPathsRef.current = new Set();
      memoryTrackerRef.current = null;
    };

    // Resume from CLI flag
    if (resumeSessionId) {
      try {
        const loaded = SessionStore.loadSession(resumeSessionId, ctxRef.current.cwd);
        const preview = SessionStore.loadTranscriptPreview(resumeSessionId, ctxRef.current.cwd);
        ctxRef.current.onResume!(loaded);
        setMessages(resumedVisibleMessages(resumeSessionId, preview, loaded));
      } catch (err) {
        setMessages([{ role: "assistant", content: `Failed to resume session: ${err instanceof Error ? err.message : String(err)}` }]);
      }
    } else {
      ctx.sessionStore.writeStart(ctx.model, ctx.config.default_provider ?? "anthropic");
      maybeWriteGitBranch(ctx.sessionStore, ctx.cwd);
    }

    // Write session_end on process exit
    const handleExit = () => {
      ctxRef.current.sessionStore.writeEnd(
        costRef.current.totalUsage,
        costRef.current.totalUsd,
        turnCountRef.current,
        inputHistoryRef.current.at(-1)
      );
    };
    process.on("exit", handleExit);
    process.on("SIGINT", handleExit);
    return () => {
      process.off("exit", handleExit);
      process.off("SIGINT", handleExit);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Streaming helpers ───────────────────────────────────────────────────────

  const flushBuffer = useCallback(() => {
    setMessages((prev) => {
      const last = prev[prev.length - 1];
      if (!last?.streaming) return prev;
      return [...prev.slice(0, -1), { ...last, content: streamingBufferRef.current }];
    });
  }, []);

  const onTextDelta = useCallback((delta: string) => {
    streamingBufferRef.current += delta;
    if (rafRef.current === null) {
      rafRef.current = setTimeout(() => {
        flushBuffer();
        rafRef.current = null;
      }, 16);
    }
  }, [flushBuffer]);

  const onUsage = useCallback((u: Usage) => {
    // Accumulate into session cost
    const updated = accumulateCost(costRef.current, u, routing.model, routing.provider);
    costRef.current = updated;

    setUsage((prev) => ({
      inputTotal: prev.inputTotal + (u.input_tokens ?? 0),
      outputTotal: prev.outputTotal + (u.output_tokens ?? 0),
      cacheWriteTotal: prev.cacheWriteTotal + (u.cache_creation_input_tokens ?? 0),
      cacheReadTotal: prev.cacheReadTotal + (u.cache_read_input_tokens ?? 0),
      costUsd: updated.totalUsd,
    }));
    setCurrentOutputTokens((prev) => prev + (u.output_tokens ?? 0));
  }, [routing.model, routing.provider]);

  const handleCancel = useCallback(() => {
    if (streamStatus !== "idle") {
      const pending = inputValue.trim();
      if (pending) {
        pendingQueueRef.current.unshift(pending);
        syncQueue();
        setInputValue("");
      }
      abortRef.current?.abort();
    } else {
      if (inputValue.length > 0) setInputValue("");
    }
  }, [inputValue, streamStatus]);

  const SCROLL_STEP = Math.max(5, Math.floor((dimensions.rows - 4) / 2));

  const handleScrollUp = useCallback(() => {
    isFollowingRef.current = false;
    setScrollOffset((prev) => prev + SCROLL_STEP);
  }, [SCROLL_STEP]);

  const handleScrollDown = useCallback(() => {
    setScrollOffset((prev) => {
      const next = Math.max(0, prev - SCROLL_STEP);
      if (next === 0) isFollowingRef.current = true;
      return next;
    });
  }, [SCROLL_STEP]);

  const handleSubmit = useCallback(async (line: string) => {
    if (streamStatus !== "idle") {
      const trimmed = line.trim();
      if (trimmed) {
        pendingQueueRef.current.push(trimmed);
        syncQueue();
      }
      return;
    }

    if (!line.startsWith("/")) {
      setMessages((prev) => [...prev, { role: "user", content: line }]);
      inputHistoryRef.current = [...inputHistoryRef.current, line];
      // Reset scroll to bottom on new user message
      isFollowingRef.current = true;
      setScrollOffset(0);
    }

    // --- Commands ---
    if (line.startsWith("/")) {
      const [cmd, ...args] = line.slice(1).split(/\s+/);
      if (cmd === "exit" || cmd === "quit") {
        ctxRef.current.sessionStore.writeEnd(
          costRef.current.totalUsage,
          costRef.current.totalUsd,
          turnCountRef.current,
          inputHistoryRef.current.at(-1)
        );
        exit();
        return;
      }

      if (cmd === "diff") {
        setDiffOpen(true);
        return;
      }

      if (cmd === "title") {
        hasCustomTitleRef.current = true;
      }

      setMessages((prev) => [...prev, { role: "user", content: line }]);
      if (cmd === "status") {
        setMessages((prev) => {
          const r = routing;
          const u = usage;
          const byModel = Object.entries(costRef.current.byModel)
            .map(([m, rec]) => `  ${m}: $${rec.costUsd.toFixed(4)}`)
            .join("\n");
          const parts = [
            `Provider: ${r.provider}`,
            `Model:    ${r.model}`,
            `Tokens:   in ${u.inputTotal.toLocaleString()} / out ${u.outputTotal.toLocaleString()}`,
            ...(u.cacheWriteTotal || u.cacheReadTotal
              ? [`Cache:    write ${u.cacheWriteTotal.toLocaleString()} / read ${u.cacheReadTotal.toLocaleString()}`]
              : []),
            `Cost:     $${u.costUsd.toFixed(4)}`,
            ...(byModel ? [`\nBy model:\n${byModel}`] : []),
          ];
          if (r.intent) {
            parts.push(`Intent:   L${r.intent.level} · ${r.intent.domain} → ${r.provider}`);
          }
          return [...prev, { role: "assistant", content: parts.join("\n") }];
        });
        return;
      }

      const output = await captureCommand(cmd!, args, ctxRef.current);
      setMessages((prev) => [...prev, { role: "assistant", content: output }]);
      return;
    }

    // --- Write user entry to session ---
    const userUuid = ctxRef.current.sessionStore.writeUser(line);

    // --- Intent routing ---
    let activeAdapter = ctxRef.current.adapter;
    let activeModel = ctxRef.current.model;
    let activeProvider = ctxRef.current.config.default_provider ?? "anthropic";
    let routingFailed = false;
    let activeIntent: IntentResult | null = null;
    const routingCfg = ctxRef.current.config.routing;
    if (routingCfg?.enabled) {
      setStreamStatus("thinking");
      const classifierTarget = routingCfg.classifier;
      const classifierAdapter = classifierTarget
        ? ctxRef.current.buildAdapter(classifierTarget.provider)
        : activeAdapter;
      const classifierModel = classifierTarget?.model ?? "claude-haiku-4-5";
      try {
        const { model: routed, provider: routedProvider, intent } = await resolveModel(
          line, classifierAdapter, classifierModel, routingCfg,
          ctxRef.current.config.default_provider ?? "anthropic",
          ctxRef.current.model,
        );
        if (routedProvider) {
          activeAdapter = ctxRef.current.buildAdapter(routedProvider);
          activeProvider = routedProvider;
        }
        activeModel = routed;
        activeIntent = intent;
        routingFailed = intent === null;
        setRouting({
          provider: routedProvider ?? ctxRef.current.config.default_provider ?? "anthropic",
          model: routed,
          intent,
        });
      } catch (err) {
        routingFailed = true;
        console.error("[routing]", err instanceof Error ? err.message : String(err));
      }
    }

    setCurrentOutputTokens(0);

    const controller = new AbortController();
    abortRef.current = controller;

    // Per-turn usage accumulator + timing + tool names (for writeAssistant)
    let turnUsage: Usage = { input_tokens: 0, output_tokens: 0 };
    const turnToolCalls: string[] = [];
    const turnStart = Date.now();
    const captureUsage = (u: Usage) => {
      turnUsage = {
        input_tokens: turnUsage.input_tokens + u.input_tokens,
        output_tokens: turnUsage.output_tokens + u.output_tokens,
        cache_creation_input_tokens:
          (turnUsage.cache_creation_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
        cache_read_input_tokens:
          (turnUsage.cache_read_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
      };
      onUsage(u);
    };

    const store = ctxRef.current.sessionStore;
    const runDir = dirname(store.filePath);
    if (projectContextRef.current === null) {
      projectContextRef.current = loadProjectContext({ cwd: ctxRef.current.cwd });
      loadedVeraContextPathsRef.current = new Set(
        projectContextRef.current.files.map((file) => file.path)
      );
    }
    if (memoryTrackerRef.current === null) {
      memoryTrackerRef.current = new MemoryTracker({
        memoryDir: join(runDir, "memory"),
      });
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
      contextOptions: {
        maxTokens: modelContextLimit,
        targetUtilization: CONTEXT_TARGET_UTILIZATION,
        keepRecentTurns: 6,
      },
      compressionOptions: {
        enabled: true,
        triggerTokens: Math.floor(modelContextLimit * COMPRESSION_TRIGGER_UTILIZATION),
        keepRecentTurns: 6,
        model: activeModel,
      },
      microCompactOptions: {
        enabled: true,
        gapThresholdMinutes: 60,
        keepRecent: 5,
      },
      compressionState: compressionStateRef.current,
      microCompactState: microCompactStateRef.current,
      memoryTracker: memoryTrackerRef.current,
      scannedMemoryFiles: frozenMemoryFilesRef.current,
      onMemorySelected: buildMemoryPreamble,
      onContextUpdate: (
        nextHistory: Message[],
        update: {
          compressionState: CompressionState | null;
          microCompactState: MicroCompactState | null;
        },
      ) => {
        historyRef.current = [...nextHistory];
        if (update.compressionState) compressionStateRef.current = update.compressionState;
        if (update.microCompactState) microCompactStateRef.current = update.microCompactState;
      },
    };

    // Resolve skill bundle if available (augments tools + system prompt)
    const skillBundle = ctxRef.current.resolveSkillBundle?.({
      domain: activeIntent?.domain ?? "chat",
      level: activeIntent?.level ?? 0,
      needs_tools: activeIntent?.needs_tools ?? false,
    });
    // Merge registry tools (always available) + any skill-specific extras (e.g. MCP tools)
    const registryTools = ctxRef.current.tools;
    const skillExtras = (skillBundle?.tools ?? []).filter(
      (t) => !registryTools.some((r) => r.name === t.name)
    );
    const activeToolsWithoutAgent = skillExtras.length ? [...registryTools, ...skillExtras] : registryTools;
    const agentDefinitions = loadAgentDefinitions({ cwd: ctxRef.current.cwd });
    const agentToolSchema = buildSubagentToolSchema(agentDefinitions);
    const activeTools = activeToolsWithoutAgent.some((tool) => tool.name === SUBAGENT_TOOL_NAME)
      ? activeToolsWithoutAgent
      : [...activeToolsWithoutAgent, agentToolSchema];
    // Base system prompt from PromptStore (templated + profile-matched), overridden by skill bundle if present
    const resolvedPrompt = ctxRef.current.promptStore.resolve({
      domain: activeIntent?.domain ?? "chat",
      level: activeIntent?.level ?? 0,
      needs_tools: activeIntent?.needs_tools ?? false,
    });
    const baseSystem = resolvedPrompt?.system ?? "You are Vera, a helpful assistant.";
    const activeSystem = mergeSystemPrompts(skillBundle?.system ?? baseSystem, projectContextRef.current?.system);
    const activeExecutors = skillBundle?.executors;

    // Shared tool call handler — used by both stream mode and plan mode
    const sharedOnToolCall = async (name: string, args: Record<string, unknown>): Promise<ToolResult> => {
      turnToolCalls.push(name);
      const toolCallUuid = store.writeToolCall({
        parentUuid: userUuid,
        toolName: name,
        toolCallId: name,
        arguments: args,
      });

      const executeOnce = async (n: string, a: Record<string, unknown>): Promise<ToolResult> => {
        if (n === SUBAGENT_TOOL_NAME) {
          const result = await runSubagentTool({
            args: a,
            adapter: activeAdapter,
            model: activeModel,
            tools: activeTools,
            system: activeSystem,
            runDir,
            signal: controller.signal,
            onUsage: captureUsage,
            cwd: ctxRef.current.cwd,
            provider: activeProvider,
            parentSessionId: store.sessionId,
            definitions: agentDefinitions,
            createToolHandlerForCwd: ({ cwd, sessionStore }) => {
              const bundle = ctxRef.current.createToolRegistry?.({ cwd, sessionStore });
              return async (childName, childArgs) => {
                if (activeExecutors?.has(childName)) {
                  return activeExecutors.get(childName)!(childArgs);
                }
                if (!bundle) {
                  const result = await executeOnce(childName, childArgs);
                  return result.content;
                }
                const result = await bundle.registry.execute(childName, childArgs, {
                  cwd,
                  sessionId: sessionStore?.sessionId ?? store.sessionId,
                });
                return result.content;
              };
            },
            onToolCall: async (childName, childArgs) => {
              const childResult = await finalizeToolResult(
                childName,
                childArgs,
                await executeOnce(childName, childArgs),
              );
              return childResult.content;
            },
          });
          return result.ok
            ? { ok: true, content: result.content, metadata: { renderHint: { type: "text" } } }
            : {
                ok: false,
                content: result.content,
                error: { code: "UNKNOWN", message: result.content, retryable: false },
              };
        }
        if (activeExecutors?.has(n)) {
          const content = await activeExecutors.get(n)!(a);
          return { ok: true, content };
        }
        const registry = ctxRef.current.registry;
        if (registry) {
          return registry.execute(n, a, { cwd: ctxRef.current.cwd, sessionId: store.sessionId });
        }
        return { ok: false, content: `Tool "${n}" is not implemented yet.`, error: { code: "UNKNOWN", message: `Tool "${n}" is not implemented yet.`, retryable: false } };
      };

      async function finalizeToolResult(
        n: string,
        a: Record<string, unknown>,
        initialResult: ToolResult,
      ): Promise<ToolResult> {
        let result = initialResult;

        // Path confirmation: suspend agent, prompt user, retry once if approved.
        if (result.needsConfirm) {
          const confirm = result.needsConfirm;
          const approved = await new Promise<boolean>((res) => {
            setPathConfirm({ message: confirm.message, allowDir: confirm.allowDir, resolve: res });
          });
          setPathConfirm(null);
          if (approved) {
            ctxRef.current.security?.allowPath(confirm.allowDir);
            result = await executeOnce(confirm.retry.name, confirm.retry.args);
          }
          // If denied, fall through with the original error result.
        }

        if (result.ok && n === "read_file") {
          const pathArg = a.path;
          if (typeof pathArg === "string") {
            const nested = loadNestedProjectContext({
              cwd: ctxRef.current.cwd,
              targetPath: pathArg,
              loadedPaths: loadedVeraContextPathsRef.current,
            });
            if (nested.system) {
              for (const file of nested.files) loadedVeraContextPathsRef.current.add(file.path);
              result = {
                ...result,
                content: [
                  result.content,
                  `<nested-vera-context>\n${nested.system}\n</nested-vera-context>`,
                ].join("\n\n"),
              };
            }
          }
        }

        return result;
      }

      let toolResult = await finalizeToolResult(name, args, await executeOnce(name, args));

      store.writeToolResult({ parentUuid: toolCallUuid, toolCallId: name, content: toolResult.content });
      return toolResult;
    };

    const usePlanMode = activeIntent !== null && shouldPlan(activeIntent);
    const writeAiTitleIfNeeded = (assistantText: string) => {
      const aiTitleConfig = ctxRef.current.config.session?.ai_title;
      if (aiTitleConfig?.enabled === false) return;
      if (hasCustomTitleRef.current || aiTitleGeneratedRef.current || aiTitleAttemptsRef.current >= 2) return;
      if (turnCountRef.current > 1) return;
      aiTitleGeneratedRef.current = true;
      aiTitleAttemptsRef.current += 1;
      const toolsSummary = turnToolCalls.length
        ? `Tools used: ${[...new Set(turnToolCalls)].slice(0, 8).join(", ")}`
        : undefined;
      void generateSessionTitle({
        adapter: aiTitleConfig?.provider ? ctxRef.current.buildAdapter(aiTitleConfig.provider) : activeAdapter,
        model: aiTitleConfig?.model ?? activeModel,
        userPrompt: line,
        assistantText: assistantText.trim() || toolsSummary,
      })
        .then((title) => {
          if (title && !hasCustomTitleRef.current) store.writeAiTitle(title);
          if (!title) aiTitleGeneratedRef.current = false;
        })
        .catch(() => {
          aiTitleGeneratedRef.current = false;
        });
    };

    // ── Plan Mode ────────────────────────────────────────────────────────────

    if (usePlanMode) {
      planStepsRef.current = [];
      planStepTextRef.current = "";

      setMessages((prev) => {
        const prefix: ChatMessage[] = routingFailed
          ? [{ role: "assistant", content: "⚠ routing failed — using default model" }]
          : [];
        return [...prev, ...prefix, {
          role: "assistant",
          content: "",
          streaming: true,
          planMode: true,
          planSteps: [],
          activeStepIndex: -1,
        }];
      });
      setStreamStatus("planning");

      const handlePlanEvent = (event: PlanEvent) => {
        switch (event.type) {
          case "plan_ready": {
            // Preserve already-done steps (handles replan events)
            const doneById = new Map(
              planStepsRef.current
                .filter((s) => s.status === "done")
                .map((s) => [s.id, s])
            );
            const steps: PlanStepUI[] = event.steps.map((s) =>
              doneById.get(s.id) ?? {
                id: s.id,
                description: s.description,
                status: "pending" as const,
                content: "",
                toolUses: [],
              }
            );
            planStepsRef.current = steps;
            setMessages((prev) => {
              const last = prev[prev.length - 1];
              if (!last?.planMode) return prev;
              return [...prev.slice(0, -1), { ...last, planSteps: steps }];
            });
            setStreamStatus("streaming");
            break;
          }
          case "step_start": {
            planStepTextRef.current = "";
            setMessages((prev) => {
              const last = prev[prev.length - 1];
              if (!last?.planMode) return prev;
              const steps = (last.planSteps ?? []).map((s, i) =>
                i === event.stepIndex ? { ...s, status: "running" as const } : s
              );
              return [...prev.slice(0, -1), { ...last, planSteps: steps, activeStepIndex: event.stepIndex }];
            });
            break;
          }
          case "step_text": {
            planStepTextRef.current += event.delta;
            if (planRafRef.current === null) {
              planRafRef.current = setTimeout(() => {
                const text = planStepTextRef.current;
                setMessages((prev) => {
                  const last = prev[prev.length - 1];
                  if (!last?.planMode || last.activeStepIndex == null || last.activeStepIndex < 0) return prev;
                  const idx = last.activeStepIndex;
                  const steps = (last.planSteps ?? []).map((s, i) =>
                    i === idx ? { ...s, content: text } : s
                  );
                  return [...prev.slice(0, -1), { ...last, planSteps: steps }];
                });
                planRafRef.current = null;
              }, 16);
            }
            break;
          }
          case "step_tool": {
            const toolUse: ToolUse = { name: event.name, args: event.args, result: event.result };
            setMessages((prev) => {
              const last = prev[prev.length - 1];
              if (!last?.planMode || last.activeStepIndex == null) return prev;
              const idx = last.activeStepIndex;
              const steps = (last.planSteps ?? []).map((s, i) =>
                i === idx ? { ...s, toolUses: [...s.toolUses, toolUse] } : s
              );
              return [...prev.slice(0, -1), { ...last, planSteps: steps }];
            });
            // Sync ref for history building
            const runningIdx = planStepsRef.current.findIndex((s) => s.status === "running");
            if (runningIdx >= 0) planStepsRef.current[runningIdx]!.toolUses.push(toolUse);
            break;
          }
          case "step_done": {
            if (planRafRef.current !== null) { clearTimeout(planRafRef.current); planRafRef.current = null; }
            const finalText = planStepTextRef.current;
            if (planStepsRef.current[event.stepIndex]) {
              planStepsRef.current[event.stepIndex]!.status = "done";
              planStepsRef.current[event.stepIndex]!.content = finalText;
            }
            setMessages((prev) => {
              const last = prev[prev.length - 1];
              if (!last?.planMode) return prev;
              const steps = (last.planSteps ?? []).map((s, i) =>
                i === event.stepIndex ? { ...s, status: "done" as const, content: finalText } : s
              );
              return [...prev.slice(0, -1), { ...last, planSteps: steps }];
            });
            break;
          }
          case "plan_done": {
            setMessages((prev) => {
              const last = prev[prev.length - 1];
              if (!last?.planMode) return prev;
              return [...prev.slice(0, -1), { ...last, streaming: false, activeStepIndex: undefined }];
            });
            break;
          }
          case "plan_error": {
            if (planRafRef.current !== null) { clearTimeout(planRafRef.current); planRafRef.current = null; }
            setMessages((prev) => {
              const last = prev[prev.length - 1];
              if (!last?.planMode) return prev;
              return [...prev.slice(0, -1), { ...last, content: `Error: ${event.error}`, streaming: false, planMode: false }];
            });
            break;
          }
        }
      };

      const planExec = ctxRef.current.planExecutor ?? defaultPlanExecutor;

      try {
        await planExec(
          line,
          {
            adapter: activeAdapter,
            model: activeModel,
            tools: activeTools,
            system: activeSystem,
            maxTurns: resolvedPrompt?.maxTurns,
            signal: controller.signal,
            onToolCall: sharedOnToolCall,
            runDir,
            history: historyRef.current,
            ...dynamicContext,
          },
          handlePlanEvent,
          captureUsage,
        );

        // Build summary text for session + history
        const summaryLines = planStepsRef.current.map((s, i) =>
          `步骤 ${i + 1}：${s.description}\n${s.content}`
        );
        const fullText = summaryLines.join("\n\n");

        store.writeAssistant({
          parentUuid: userUuid,
          content: fullText,
          model: activeModel,
          provider: activeProvider,
          stopReason: "end_turn",
          usage: turnUsage,
          turn: turnCountRef.current + 1,
          latencyMs: Date.now() - turnStart,
          toolCalls: turnToolCalls,
          status: "ok",
        });

        historyRef.current = [
          ...historyRef.current,
          { role: "user", content: line } satisfies Message,
          { role: "assistant", content: fullText } satisfies Message,
        ];
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

    // ── Stream Mode (regular ReAct) ──────────────────────────────────────────

    setMessages((prev) => {
      const base: ChatMessage = { role: "assistant", content: "", streaming: true };
      const prefix: ChatMessage[] = routingFailed
        ? [{ role: "assistant", content: "⚠ routing failed — using default model" }]
        : [];
      return [...prev, ...prefix, base];
    });
    setStreamStatus("streaming");
    streamingBufferRef.current = "";

    try {
      const fullText = await streamAgent(
        line,
        {
          adapter: activeAdapter,
          model: activeModel,
          tools: activeTools,
          system: activeSystem,
          maxTurns: resolvedPrompt?.maxTurns,
          history: historyRef.current,
          onUsage: captureUsage,
          signal: controller.signal,
          runDir,
          ...dynamicContext,
          onToolCall: async (name, args) => {
            if (rafRef.current !== null) {
              clearTimeout(rafRef.current);
              rafRef.current = null;
            }
            const preface = streamingBufferRef.current.trim();
            streamingBufferRef.current = "";
            setMessages((prev) => {
              const last = prev[prev.length - 1];
              if (!last?.streaming || !last.content) return prev;
              return [...prev.slice(0, -1), { ...last, content: "" }];
            });
            const toolResult = await sharedOnToolCall(name, args as Record<string, unknown>);
            // Append to toolUses on the current streaming message
            const toolUse: ToolUse = {
              name,
              args: args as Record<string, unknown>,
              result: toolResult,
              ...(preface ? { preface } : {}),
            };
            setMessages((prev) => {
              const last = prev[prev.length - 1];
              if (!last?.streaming) return prev;
              return [
                ...prev.slice(0, -1),
                { ...last, toolUses: [...(last.toolUses ?? []), toolUse] },
              ];
            });
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
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (!last?.streaming) return prev;
        return [...prev.slice(0, -1), { ...last, content: fullText, streaming: false }];
      });

      writeAiTitleIfNeeded(fullText);
      // Write assistant entry
      store.writeAssistant({
        parentUuid: userUuid,
        content: fullText,
        model: activeModel,
        provider: activeProvider,
        stopReason: "end_turn",
        usage: turnUsage,
        turn: turnCountRef.current + 1,
        latencyMs: Date.now() - turnStart,
        toolCalls: turnToolCalls,
        status: "ok",
      });

      turnCountRef.current += 1;
    } catch (err) {
      if (rafRef.current !== null) {
        clearTimeout(rafRef.current);
        rafRef.current = null;
      }
      const isAbort =
        err instanceof Error &&
        (err.name === "AbortError" || err.message.includes("aborted"));
      const errMsg = isAbort ? "Cancelled." : formatError(err);
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (last?.streaming) {
          const content = last.content || errMsg;
          return [...prev.slice(0, -1), { role: "assistant", content, streaming: false }];
        }
        return [...prev, { role: "assistant", content: errMsg }];
      });
      if (!isAbort) {
        store.writeAssistant({
          parentUuid: userUuid,
          content: errMsg,
          model: activeModel,
          provider: activeProvider,
          stopReason: "end_turn",
          usage: turnUsage,
          turn: turnCountRef.current + 1,
          latencyMs: Date.now() - turnStart,
          toolCalls: turnToolCalls,
          status: "error",
        });
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

  const { columns, rows } = dimensions;
  // Reserve rows for: separator(1) + statusbar(1) + pendingQueue + inputbar(1) + buffer(1)
  const reservedRows = 4 + pendingQueue.length;
  const availableHeight = Math.max(5, rows - reservedRows);

  if (diffOpen) {
    return (
      <DiffDialog
        cwd={ctx.cwd}
        width={columns}
        height={dimensions.rows}
        onClose={() => setDiffOpen(false)}
      />
    );
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
              setMessages((prev) => [
                ...prev,
                ...resumedVisibleMessages(sessionId, preview, loaded),
              ]);
            } catch (err) {
              setMessages((prev) => [
                ...prev,
                { role: "assistant", content: `Failed to load session: ${err instanceof Error ? err.message : String(err)}` },
              ]);
            }
          }}
          onClose={() => setSessionPickerOpen(false)}
        />
      </Box>
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
      />
      {messages.length > 0 && (
        <>
          <ConversationPanel
            messages={messages}
            width={columns}
            availableHeight={availableHeight}
            scrollOffset={scrollOffset}
            expandToolOutput={expandToolOutput}
          />
          <Box>
            <Text color="gray">{"─".repeat(columns)}</Text>
          </Box>
          <StatusBar
            status={streamStatus}
            outputTokens={currentOutputTokens}
            pendingCount={pendingQueue.length}
            scrollOffset={scrollOffset}
            expandToolOutput={expandToolOutput}
          />
          {pendingQueue.map((msg, i) => (
            <Box key={i}>
              <Text color="yellow">{"⏎ "}</Text>
              <Text color="#b8860b" wrap="truncate-end">{msg}</Text>
            </Box>
          ))}
          {pathConfirm ? (
            <Box flexDirection="column">
              <Text color="yellow">⚠ {pathConfirm.message}</Text>
              <Text color="yellow">Allow? [y/N] </Text>
              <InputBar
                value={inputValue}
                onChange={setInputValue}
                onSubmit={(line) => {
                  const approved = line.trim().toLowerCase() === "y";
                  setInputValue("");
                  pathConfirm.resolve(approved);
                }}
                onExit={exit}
                onCancel={() => { setInputValue(""); pathConfirm.resolve(false); }}
                isStreaming={false}
                history={[]}
                onScrollUp={handleScrollUp}
                onScrollDown={handleScrollDown}
                onToggleToolOutput={() => setExpandToolOutput((v) => !v)}
              />
            </Box>
          ) : (
            <InputBar
              value={inputValue}
              onChange={setInputValue}
              onSubmit={handleSubmit}
              onExit={exit}
              onCancel={handleCancel}
              isStreaming={streamStatus !== "idle"}
              history={inputHistoryRef.current}
              onScrollUp={handleScrollUp}
              onScrollDown={handleScrollDown}
              onToggleToolOutput={() => setExpandToolOutput((v) => !v)}
            />
          )}
        </>
      )}
    </Box>
  );
}
