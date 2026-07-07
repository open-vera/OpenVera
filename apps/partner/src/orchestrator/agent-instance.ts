import { abortAgent, invokeAgentRun, waitForAgentCompletion } from "@/bridge/agent";
import { subscribeAgentStream } from "@/bridge/events";
import type {
  AgentRunMode,
  LLMRuntimeConfig,
  Message,
  TokenUsage,
  ToolApprovalRequest,
  ToolCall,
  ToolResult,
} from "@/types";
import { AgentRunError, type AgentRunDiagnostics } from "@/utils/error.js";

export interface AgentRunCallbacks {
  onReady?: () => void;
  onDelta: (delta: string) => void;
  onToolCall?: (toolCall: ToolCall) => void;
  onToolResult?: (toolResult: ToolResult) => void;
  onToolApprovalRequired?: (approval: ToolApprovalRequest) => void;
  onThinking?: () => void;
}

const MODEL_IDLE_TIMEOUT_MS = 45_000;

export class AgentInstanceRunner {
  readonly id: string;
  readonly sessionId: string;
  status: "idle" | "running" | "error" = "idle";
  private abortRequested = false;
  private cleanupStream: (() => void) | null = null;

  constructor(sessionId: string) {
    this.id = crypto.randomUUID();
    this.sessionId = sessionId;
  }

  async run(
    message: string,
    history: Message[],
    callbacks: AgentRunCallbacks,
    projectRoot?: string,
    llmConfig?: LLMRuntimeConfig | null,
    taskId?: string,
    agentMode?: AgentRunMode,
  ): Promise<{ text: string; usage?: TokenUsage }> {
    this.status = "running";
    this.abortRequested = false;
    const requestId = crypto.randomUUID();
    const diagnostics = (): AgentRunDiagnostics => ({
      ...(taskId ? { taskId } : {}),
      requestId,
      sessionId: this.sessionId,
      instanceId: this.id,
    });
    const toRunError = (error: unknown): AgentRunError => {
      if (error instanceof AgentRunError) return error;
      const message = error instanceof Error ? error.message : String(error);
      return new AgentRunError(message, diagnostics());
    };
    let idleTimeout: ReturnType<typeof setTimeout> | null = null;
    let rejectIdleTimeout: ((error: Error) => void) | null = null;
    let rejectStreamError: ((error: Error) => void) | null = null;
    const clearIdleTimeout = () => {
      if (!idleTimeout) return;
      clearTimeout(idleTimeout);
      idleTimeout = null;
    };
    const resetIdleTimeout = () => {
      clearIdleTimeout();
      idleTimeout = setTimeout(() => {
        this.abortRequested = true;
        void abortAgent(this.sessionId);
        rejectIdleTimeout?.(
          new AgentRunError(
            "模型响应超时：45 秒内没有收到任何运行事件，请检查网络、API Key 或模型服务状态。",
            diagnostics(),
          ),
        );
      }, MODEL_IDLE_TIMEOUT_MS);
    };
    const idleTimeoutPromise = new Promise<never>((_resolve, reject) => {
      rejectIdleTimeout = reject;
    });
    const streamErrorPromise = new Promise<never>((_resolve, reject) => {
      rejectStreamError = reject;
    });

    this.cleanupStream = await subscribeAgentStream({
      requestId,
      instanceId: this.id,
      onReady: () => {
        resetIdleTimeout();
        callbacks.onReady?.();
      },
      onDelta: (delta) => {
        resetIdleTimeout();
        callbacks.onDelta(delta);
      },
      onError: (payload) => {
        resetIdleTimeout();
        rejectStreamError?.(new AgentRunError(payload.message, diagnostics()));
      },
      onToolCall: callbacks.onToolCall
        ? (toolCall) => {
            resetIdleTimeout();
            callbacks.onToolCall?.(toolCall);
          }
        : undefined,
      onToolResult: callbacks.onToolResult
        ? (toolResult) => {
            resetIdleTimeout();
            callbacks.onToolResult?.(toolResult);
          }
        : undefined,
      onToolApprovalRequired: callbacks.onToolApprovalRequired
        ? (approval) => {
            clearIdleTimeout();
            callbacks.onToolApprovalRequired?.(approval);
          }
        : undefined,
      onThinking: callbacks.onThinking
        ? () => {
            resetIdleTimeout();
            callbacks.onThinking?.();
          }
        : undefined,
      onUsage: (usage) => {
        resetIdleTimeout();
        /* Phase 2+: wire to settings/cost store */
        void usage;
      },
    });

    const completion = waitForAgentCompletion(requestId, this.id);
    resetIdleTimeout();

    try {
      const runStarted = invokeAgentRun({
        requestId,
        instanceId: this.id,
        sessionId: this.sessionId,
        message,
        history,
        projectRoot,
        llmConfig: llmConfig ?? undefined,
        taskId,
        agentMode,
      });
      const result = await Promise.race([
        runStarted.then(() => completion),
        idleTimeoutPromise,
        streamErrorPromise,
      ]);
      this.status = "idle";
      return result;
    } catch (error) {
      this.status = this.abortRequested ? "idle" : "error";
      throw toRunError(error);
    } finally {
      clearIdleTimeout();
      this.cleanupStream?.();
      this.cleanupStream = null;
    }
  }

  abort(): void {
    this.abortRequested = true;
    void abortAgent(this.sessionId);
  }
}
