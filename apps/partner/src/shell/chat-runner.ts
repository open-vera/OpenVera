/**
 * Shell chat runner: projects agent:stream:* into Pinia chat UI,
 * sends via Host `host.session.send`. No Orchestrator / TaskQueue.
 */
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useChatStore } from "@/stores/chat";
import { usePreviewStore } from "@/stores/preview";
import { useSettingsStore } from "@/stores/settings";
import { useHostStore } from "@/shell/host-store";
import type { ChatAttachment, FileChange, TokenUsage } from "@/types";
import { buildAgentMessageContent } from "@/utils/attachments.js";
import { formatErrorMessage } from "@/utils/error.js";

class ChatRunner {
  private unlisteners: UnlistenFn[] = [];
  private listening = false;
  private activeTurnId: string | null = null;
  /** Current text segment, null while tool steps are streaming. */
  private activeAssistantId: string | null = null;
  /** Current tool segment, null while text is streaming. */
  private activeProgressId: string | null = null;
  private activeChatTabId: string | null = null;
  private thinkingStepAdded = false;
  /** callId → tool segment, so a late result lands in the segment that called it. */
  private segmentByCallId = new Map<string, string>();

  /**
   * Text resumed: close the tool segment and open a new assistant message, so
   * narration between two tool batches renders where it actually happened.
   */
  private ensureTextSegment(): string | null {
    if (this.activeAssistantId) return this.activeAssistantId;
    if (!this.activeChatTabId || !this.activeTurnId) return null;
    const chat = useChatStore();
    const now = Date.now();
    if (this.activeProgressId) {
      chat.setMessageEndedAt(this.activeProgressId, now, this.activeChatTabId);
      this.activeProgressId = null;
    }
    const id = crypto.randomUUID();
    chat.append(
      {
        id,
        role: "assistant",
        content: "",
        timestamp: now,
        isStreaming: true,
        turnId: this.activeTurnId,
      },
      this.activeChatTabId,
    );
    this.activeAssistantId = id;
    return id;
  }

  /** Tool work started: finalize the open text segment and start a tool segment. */
  private ensureToolSegment(): string | null {
    if (this.activeProgressId) return this.activeProgressId;
    if (!this.activeChatTabId || !this.activeTurnId) return null;
    const chat = useChatStore();
    if (this.activeAssistantId) {
      chat.finalizeMessage(this.activeAssistantId, this.activeChatTabId);
      this.activeAssistantId = null;
    }
    const id = crypto.randomUUID();
    chat.append(
      {
        id,
        role: "tool",
        content: "",
        timestamp: Date.now(),
        toolCalls: [],
        turnId: this.activeTurnId,
      },
      this.activeChatTabId,
    );
    this.activeProgressId = id;
    return id;
  }

  /** Add a step to the current tool segment (agent_thinking, approvals, …). */
  private appendProgressStep(name: string, input: Record<string, unknown> = {}, id?: string) {
    const segmentId = this.ensureToolSegment();
    if (!segmentId || !this.activeChatTabId) return;
    const callId = id ?? crypto.randomUUID();
    this.segmentByCallId.set(callId, segmentId);
    useChatStore().appendToolCall(
      segmentId,
      { id: callId, name, input },
      this.activeChatTabId,
    );
  }

  async ensureListening(): Promise<void> {
    if (this.listening) return;
    this.listening = true;
    this.unlisteners.push(
      await listen<{ delta?: string }>("agent:stream:delta", (event) => {
        const chunk = event.payload.delta ?? "";
        if (!chunk) return;
        const assistantId = this.ensureTextSegment();
        if (!assistantId || !this.activeChatTabId) return;
        useChatStore().updateStreaming(assistantId, chunk, this.activeChatTabId);
      }),
      await listen<{ name?: string; callId?: string; input?: unknown }>(
        "agent:stream:tool_call",
        (event) => {
          this.appendProgressStep(
            event.payload.name ?? "tool",
            (event.payload.input as Record<string, unknown>) ?? {},
            event.payload.callId,
          );
        },
      ),
      await listen<{
        callId?: string;
        output?: string;
        isError?: boolean;
        fileChange?: FileChange;
      }>("agent:stream:tool_result", (event) => {
        if (!this.activeChatTabId) return;
        const callId = event.payload.callId ?? "";
        // Route to the segment that issued the call — text may have resumed since.
        const segmentId = this.segmentByCallId.get(callId) ?? this.ensureToolSegment();
        if (!segmentId) return;
        useChatStore().appendToolResult(
          segmentId,
          {
            id: callId || crypto.randomUUID(),
            output: event.payload.output ?? "",
            isError: event.payload.isError,
            fileChange: event.payload.fileChange,
          },
          this.activeChatTabId,
        );
      }),
      await listen<{
        callId?: string;
        name?: string;
        input?: Record<string, unknown>;
        reason?: string;
        cmd?: string;
        args?: string[];
        cwd?: string;
        allowDir?: string;
      }>("agent:tool_approval_required", (event) => {
        const callId = event.payload.callId ?? crypto.randomUUID();
        this.appendProgressStep(
          "tool_approval_required",
          {
            callId,
            toolName: event.payload.name,
            reason: event.payload.reason,
            cmd: event.payload.cmd,
            args: event.payload.args,
            cwd: event.payload.cwd,
            allowDir: event.payload.allowDir,
            input: event.payload.input,
          },
          callId,
        );
      }),
      await listen("agent:stream:ready", () => {
        this.appendProgressStep("agent_model_ready");
      }),
      await listen("agent:stream:thinking", () => {
        if (this.thinkingStepAdded) return;
        this.thinkingStepAdded = true;
        this.appendProgressStep("agent_thinking");
      }),
      // Token usage / TTFT / duration for the usage rings (composer + progress panel).
      await listen<{ usage?: TokenUsage }>("agent:stream:usage", (event) => {
        if (!this.activeChatTabId || !event.payload.usage) return;
        useChatStore().updateRunUsage(event.payload.usage, this.activeChatTabId);
      }),
      await listen<{ usage?: TokenUsage }>("agent:stream:done", (event) => {
        if (this.activeChatTabId && event.payload?.usage) {
          useChatStore().updateRunUsage(event.payload.usage, this.activeChatTabId);
        }
        this.finishRun();
      }),
      await listen<{ message?: string }>("agent:stream:error", (event) => {
        this.failRun(event.payload.message ?? "agent error");
      }),
    );
  }

  private finishRun() {
    const chat = useChatStore();
    const endedAt = Date.now();
    if (this.activeChatTabId) {
      if (this.activeAssistantId) {
        chat.finalizeMessage(this.activeAssistantId, this.activeChatTabId);
      }
      if (this.activeProgressId) {
        chat.setMessageEndedAt(this.activeProgressId, endedAt, this.activeChatTabId);
      }
      if (this.activeTurnId) {
        chat.closeTurn(this.activeTurnId, endedAt, this.activeChatTabId);
      }
      chat.setAgentRunning(false, this.activeChatTabId);
    }
    this.resetRunState();
  }

  private failRun(message: string) {
    const chat = useChatStore();
    const endedAt = Date.now();
    if (this.activeChatTabId) {
      // Surface the failure as text, opening a segment when tools were last.
      const assistantId = this.ensureTextSegment();
      if (assistantId) {
        chat.markMessageError(
          assistantId,
          formatErrorMessage(message),
          this.activeChatTabId,
        );
      }
      if (this.activeTurnId) {
        chat.closeTurn(this.activeTurnId, endedAt, this.activeChatTabId);
      }
      chat.setAgentRunning(false, this.activeChatTabId);
    }
    this.resetRunState();
  }

  private resetRunState() {
    this.activeAssistantId = null;
    this.activeProgressId = null;
    this.activeChatTabId = null;
    this.activeTurnId = null;
    this.segmentByCallId.clear();
  }

  async sendMessage(
    text: string,
    projectRoot?: string,
    attachments: ChatAttachment[] = [],
  ): Promise<void> {
    await this.ensureListening();
    const chat = useChatStore();
    const host = useHostStore();
    const settings = useSettingsStore();
    const preview = usePreviewStore();

    if (!host.booted) await host.boot();

    const chatTabId = chat.ensureActiveChatTab();
    this.activeChatTabId = chatTabId;
    const displayText = text.trim() || "请查看附件内容。";
    const resolvedRoot =
      projectRoot ?? host.previewProject?.rootPath ?? undefined;
    const activePreviewTab = preview.tabs.find((tab) => tab.id === preview.activeTabId);
    const openFilePaths = preview.tabs
      .map((tab) => tab.filePath)
      .filter((path): path is string => Boolean(path));
    const agentText = buildAgentMessageContent(text, attachments, {
      activeFilePath: activePreviewTab?.filePath ?? null,
      openFilePaths,
      projectRoot: resolvedRoot,
    });

    let sessionId = host.doc.activeTabId;
    if (!sessionId || sessionId === "settings" || !host.doc.sessions[sessionId]) {
      const created = await host.createSession(
        host.doc.previewProjectId,
        displayText.slice(0, 40),
      );
      sessionId = created.sessionId;
    }

    const taskId = crypto.randomUUID();
    chat.append(
      {
        id: taskId,
        role: "user",
        content: displayText,
        agentContent: agentText,
        attachments,
        timestamp: Date.now(),
      },
      chatTabId,
    );

    const progressId = crypto.randomUUID();
    const turnId = crypto.randomUUID();
    this.activeTurnId = turnId;
    this.activeProgressId = progressId;
    // Text segments are created on the first delta, so narration always lands
    // after the tool steps that preceded it.
    this.activeAssistantId = null;
    this.thinkingStepAdded = false;
    this.segmentByCallId.clear();
    // Keep the session context-window reading, clear this-turn totals.
    chat.updateRunUsage(null, chatTabId);
    chat.setAgentRunning(true, chatTabId);
    chat.append(
      {
        id: progressId,
        role: "tool",
        content: "agent_start({})",
        timestamp: Date.now(),
        toolCalls: [{ id: crypto.randomUUID(), name: "agent_start", input: {} }],
        turnId,
      },
      chatTabId,
    );

    try {
      const llmConfig = await settings.runtimeLlmConfig(resolvedRoot);
      await host.sendMessage(sessionId, agentText, {
        projectRoot: resolvedRoot,
        llmConfig,
        agentMode: settings.agentMode,
        attachments,
      });
    } catch (error) {
      this.failRun(error instanceof Error ? error.message : String(error));
    }
  }

  abort(_options?: { discardQueue?: boolean }): void {
    const host = useHostStore();
    const sessionId =
      host.doc.orchestrator.runningSessionId ?? host.doc.activeTabId;
    if (sessionId && sessionId !== "settings") {
      void host.abortSession(sessionId);
    }
    this.failRun("已中止");
  }

  dispose(): void {
    for (const unlisten of this.unlisteners) unlisten();
    this.unlisteners = [];
    this.listening = false;
  }
}

let runner: ChatRunner | undefined;

export function getChatRunner(): ChatRunner {
  runner ??= new ChatRunner();
  return runner;
}
