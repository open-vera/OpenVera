import { useEffect } from "react";
import type { MutableRefObject } from "react";
import { SessionStore } from "../../../session/index.js";
import {
  createCompressionState,
  createMicroCompactState,
} from "../../../context/index.js";
import { resolveResumeWorkspace } from "../../workspace.js";
import type { ReplContext } from "../../context.js";
import { debugLog } from "../../debugLog.js";
import type { Message } from "../../../types/index.js";
import type { CompressionState, MicroCompactState } from "../../../context/index.js";
import type { MemoryTracker, MemoryFile } from "../../../memory/index.js";
import type { ProjectContext } from "../../../project-context/index.js";
import type { AccumulatedCost } from "../../../session/index.js";
import type { ChatMessage, TokenUsage } from "../types.js";
import { maybeWriteGitBranch, resumedVisibleMessages } from "../utils.js";

const MEMORY_REFRESH_TURNS = 5;

export interface SessionLifecycleProps {
  ctx: ReplContext;
  resumeSessionId: string | undefined;
  ctxRef: MutableRefObject<ReplContext>;
  historyRef: MutableRefObject<Message[]>;
  compressionStateRef: MutableRefObject<CompressionState>;
  microCompactStateRef: MutableRefObject<MicroCompactState>;
  memoryTrackerRef: MutableRefObject<MemoryTracker | null>;
  frozenMemoryFilesRef: MutableRefObject<MemoryFile[]>;
  frozenMemorySignatureRef: MutableRefObject<string>;
  frozenMemoryTurnRef: MutableRefObject<number>;
  loadedVeraContextPathsRef: MutableRefObject<Set<string>>;
  projectContextRef: MutableRefObject<ProjectContext | null>;
  costRef: MutableRefObject<AccumulatedCost>;
  turnCountRef: MutableRefObject<number>;
  inputHistoryRef: MutableRefObject<string[]>;
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  setUsage: React.Dispatch<React.SetStateAction<TokenUsage>>;
  setSessionPickerOpen: (open: boolean) => void;
}

export function useSessionLifecycle(props: SessionLifecycleProps): void {
  const {
    ctx, resumeSessionId, ctxRef,
    historyRef, compressionStateRef, microCompactStateRef,
    memoryTrackerRef, frozenMemoryFilesRef, frozenMemorySignatureRef,
    frozenMemoryTurnRef, loadedVeraContextPathsRef, projectContextRef,
    costRef, turnCountRef, inputHistoryRef,
    setMessages, setUsage, setSessionPickerOpen,
  } = props;

  useEffect(() => {
    debugLog("[useSessionLifecycle] effect running — registering onResume / onShowSessionPicker / onSwitchWorkspace");

    ctxRef.current.onResume = (loaded) => {
      const t0 = Date.now();
      debugLog(`[onResume] ▸ called: sessionId=${loaded.sessionId} turns=${loaded.turnCount} history=${loaded.history.length} msgs`);
      const workspace = resolveResumeWorkspace(loaded, ctxRef.current.cwd);
      debugLog(`[onResume] resolved workspace: cwd=${workspace.cwd}${workspace.warning ? " (warning: " + workspace.warning + ")" : ""}`);
      const resumedStore = new SessionStore({ sessionId: loaded.sessionId, cwd: loaded.cwd });
      debugLog(`[onResume] → onSwitchWorkspace`);
      ctxRef.current.onSwitchWorkspace?.(workspace.cwd, resumedStore);
      debugLog(`[onResume] ← onSwitchWorkspace done`);
      ctxRef.current.sessionStore = resumedStore;
      historyRef.current = loaded.history;
      compressionStateRef.current = createCompressionState();
      microCompactStateRef.current = createMicroCompactState();
      memoryTrackerRef.current = null;
      frozenMemoryFilesRef.current = [];
      frozenMemorySignatureRef.current = "";
      frozenMemoryTurnRef.current = -MEMORY_REFRESH_TURNS;
      loadedVeraContextPathsRef.current = new Set(
        projectContextRef.current?.files.map((f) => f.path) ?? []
      );
      costRef.current = { totalUsd: loaded.totalCostUsd, byModel: {}, totalUsage: loaded.totalUsage };
      turnCountRef.current = loaded.turnCount;
      debugLog(`[onResume] → setUsage`);
      setUsage((prev) => ({
        ...prev,
        inputTotal: loaded.totalUsage.input_tokens,
        outputTotal: loaded.totalUsage.output_tokens,
        cacheWriteTotal: loaded.totalUsage.cache_creation_input_tokens ?? 0,
        cacheReadTotal: loaded.totalUsage.cache_read_input_tokens ?? 0,
        costUsd: loaded.totalCostUsd,
      }));
      debugLog(`[onResume] → writeStart`);
      resumedStore.writeStart(
        loaded.model || ctxRef.current.model,
        loaded.provider || (ctxRef.current.config.default_provider ?? "anthropic"),
      );
      maybeWriteGitBranch(resumedStore, ctxRef.current.cwd);
      if (workspace.warning) debugLog(`[onResume] warning: ${workspace.warning}`);
      debugLog(`[onResume] ◂ complete (${Date.now() - t0}ms)`);
    };

    ctxRef.current.onShowSessionPicker = () => {
      debugLog("[onShowSessionPicker] called → dispatching overlay open");
      setSessionPickerOpen(true);
      debugLog("[onShowSessionPicker] returned (state dispatch is async)");
    };

    ctxRef.current.onSwitchWorkspace = (cwd, sessionStore) => {
      debugLog(`[onSwitchWorkspace] cwd=${cwd}`);
      ctxRef.current.cwd = cwd;
      const bundle = ctxRef.current.createToolRegistry?.({ cwd, sessionStore });
      if (bundle) {
        ctxRef.current.registry = bundle.registry;
        ctxRef.current.toolHost = bundle.toolHost;
        ctxRef.current.security = bundle.security;
        ctxRef.current.tools = bundle.toolHost.getSchemas();
        void bundle.loadPlugins().then(() => {
          if (ctxRef.current.cwd === cwd) {
            ctxRef.current.tools = bundle.toolHost.getSchemas();
          }
        }).catch((err: unknown) => {
          debugLog(`[onSwitchWorkspace] plugin load failed: ${err instanceof Error ? err.message : String(err)}`);
        });
      }
      projectContextRef.current = null;
      loadedVeraContextPathsRef.current = new Set();
      memoryTrackerRef.current = null;
      debugLog(`[onSwitchWorkspace] done`);
    };

    if (resumeSessionId) {
      debugLog(`[useSessionLifecycle] resumeSessionId=${resumeSessionId} — loading on startup`);
      try {
        const t0 = Date.now();
        const loaded = SessionStore.loadSession(resumeSessionId, ctxRef.current.cwd);
        const preview = SessionStore.loadTranscriptPreview(resumeSessionId, ctxRef.current.cwd);
        debugLog(`[useSessionLifecycle] loaded session+preview in ${Date.now() - t0}ms`);
        ctxRef.current.onResume!(loaded);
        setMessages(resumedVisibleMessages(resumeSessionId, preview, loaded));
        debugLog(`[useSessionLifecycle] startup resume complete`);
      } catch (err) {
        debugLog(`[useSessionLifecycle] startup resume FAILED: ${err}`);
        setMessages([{ role: "assistant", content: `Failed to resume session: ${err instanceof Error ? err.message : String(err)}` }]);
      }
    } else {
      ctx.sessionStore.writeStart(ctx.model, ctx.config.default_provider ?? "anthropic");
      maybeWriteGitBranch(ctx.sessionStore, ctx.cwd);
    }

    const handleExit = () => {
      ctxRef.current.sessionStore.writeEnd(
        costRef.current.totalUsage,
        costRef.current.totalUsd,
        turnCountRef.current,
        inputHistoryRef.current.at(-1),
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
}
