import { loadPartnerSessions, savePartnerSessions } from "@/bridge";
import { useChatStore } from "@/stores/chat";
import { usePreviewStore } from "@/stores/preview";
import { useSessionStore } from "@/stores/session";
import { useSettingsStore } from "@/stores/settings";
import { useWorkspaceStore } from "@/stores/workspace";
import type { ChatAttachment, ToolCall } from "@/types";
import { buildAgentMessageContent } from "@/utils/attachments.js";
import { formatErrorMessage, extractAgentRunDiagnostics } from "@/utils/error.js";
import { appendPartnerRunLogEntry } from "@/utils/run-log.js";
import { upsertPartnerTaskSnapshot } from "@/utils/partner-sessions.js";
import { AgentInstanceRunner } from "./agent-instance.js";
import { Gateway } from "./gateway.js";
import { TaskQueue } from "./task-queue.js";

export class Orchestrator {
  private readonly gateway: Gateway;
  private readonly taskQueue: TaskQueue;
  private activeInstance: AgentInstanceRunner | null = null;
  private abortRequested = false;

  constructor(maxInstances = 3) {
    this.gateway = new Gateway(maxInstances);
    this.taskQueue = new TaskQueue();
  }

  async sendMessage(
    text: string,
    projectRoot?: string,
    attachments: ChatAttachment[] = [],
  ): Promise<void> {
    const chat = useChatStore();
    this.abortRequested = false;
    const chatTabId = chat.ensureActiveChatTab();
    const displayText = text.trim() || "请查看附件内容。";
    const workspace = useWorkspaceStore();
    const resolvedRoot = projectRoot ?? (workspace.rootPath || undefined);
    const preview = usePreviewStore();
    const activePreviewTab = preview.tabs.find((tab) => tab.id === preview.activeTabId);
    const openFilePaths = preview.tabs
      .map((tab) => tab.filePath)
      .filter((path): path is string => Boolean(path));
    const agentText = buildAgentMessageContent(text, attachments, {
      activeFilePath: activePreviewTab?.filePath ?? null,
      openFilePaths,
      projectRoot: resolvedRoot,
    });
    const taskId = crypto.randomUUID();

    chat.append({
      id: crypto.randomUUID(),
      role: "user",
      content: displayText,
      agentContent: agentText,
      attachments,
      timestamp: Date.now(),
    }, chatTabId);
    this.appendUserRunLog("user_message", displayText, agentText, chatTabId, resolvedRoot, attachments, taskId);

    if (chat.isAgentRunning) {
      this.taskQueue.enqueue({
        id: taskId,
        title: displayText,
        text: agentText,
        attachments,
        chatTabId,
        projectRoot,
        steps: [],
        createdAt: Date.now(),
      });
      this.appendUserRunLog(
        "user_message_queued",
        displayText,
        agentText,
        chatTabId,
        resolvedRoot,
        attachments,
        taskId,
      );
      return;
    }

    await this.runMessage(agentText, chatTabId, resolvedRoot, displayText, taskId);
  }

  private appendUserRunLog(
    event: "user_message" | "user_message_queued",
    displayText: string,
    agentText: string,
    chatTabId: string,
    projectRoot: string | undefined,
    attachments: ChatAttachment[],
    taskId?: string,
  ): void {
    if (!projectRoot) return;
    const session = useSessionStore();
    void appendPartnerRunLogEntry(projectRoot, {
      event,
      sessionId: session.current.id,
      windowId: session.current.windowId,
      chatTabId,
      messagePreview: displayText.slice(0, 240),
      agentMessagePreview: agentText.slice(0, 240),
      attachmentCount: attachments.length,
      attachments: attachments.map((attachment) => ({
        name: attachment.name,
        kind: attachment.kind,
        mimeType: attachment.mimeType,
        size: attachment.size,
      })),
      queueSize: this.taskQueue.size(),
      ...(taskId ? { taskId } : {}),
    }, taskId).catch((error) => {
      console.warn("[RunLog] failed to append user message:", error);
    });
  }

  private async runMessage(
    text: string,
    chatTabId: string,
    projectRoot?: string,
    taskTitle = text,
    taskId: string = crypto.randomUUID(),
  ): Promise<void> {
    const chat = useChatStore();
    const session = useSessionStore();
    const preview = usePreviewStore();
    const taskCreatedAt = Date.now();

    session.touch();

    if (!this.activeInstance) {
      this.activeInstance =
        this.gateway.createInstance(session.current.id) ?? null;
    }

    if (!this.activeInstance) {
      chat.append({
        id: crypto.randomUUID(),
        role: "assistant",
        content: "已达到最大 Agent 实例数，请稍后再试。",
        timestamp: Date.now(),
      }, chatTabId);
      return;
    }

    const assistantId = crypto.randomUUID();
    const progressId = crypto.randomUUID();
    const priorMessages = [...chat.messagesForTab(chatTabId)];
    chat.setActiveTaskId(taskId, chatTabId);
    chat.setAgentRunning(true, chatTabId);
    chat.append({
      id: progressId,
      role: "tool",
      content: "agent_start({})",
      timestamp: Date.now(),
      toolCalls: [
        {
          id: crypto.randomUUID(),
          name: "agent_start",
          input: {},
        },
      ],
    }, chatTabId);
    chat.append({
      id: assistantId,
      role: "assistant",
      content: "",
      timestamp: Date.now(),
      isStreaming: true,
    }, chatTabId);

    let thinkingStepAdded = false;
    const appendProgressStep = (toolCall: ToolCall) => {
      chat.appendToolCall(progressId, toolCall, chatTabId);
    };

    const handleToolCall = (toolCall: ToolCall) => {
      appendProgressStep(toolCall);
    };

    const handleThinking = () => {
      if (thinkingStepAdded) return;
      thinkingStepAdded = true;
      appendProgressStep({
        id: crypto.randomUUID(),
        name: "agent_thinking",
        input: {},
      });
    };

    const workspace = useWorkspaceStore();
    const resolvedRoot = projectRoot ?? (workspace.rootPath || undefined);

    try {
      appendProgressStep({
        id: crypto.randomUUID(),
        name: "agent_config",
        input: {},
      });
      const settings = useSettingsStore();
      const llmConfig = await settings.runtimeLlmConfig(resolvedRoot);
      appendProgressStep({
        id: crypto.randomUUID(),
        name: "agent_wait_model",
        input: {},
      });
      await this.activeInstance.run(
        text,
        priorMessages,
        {
          onDelta: (delta) => chat.updateStreaming(assistantId, delta, chatTabId),
          onToolCall: handleToolCall,
          onToolResult: (toolResult) => {
            chat.appendToolResult(progressId, toolResult, chatTabId);
          },
          onToolApprovalRequired: (approval) => {
            appendProgressStep({
              id: approval.callId,
              name: "tool_approval_required",
              input: {
                callId: approval.callId,
                toolName: approval.name,
                reason: approval.reason,
                cmd: approval.cmd,
                args: approval.args,
                cwd: approval.cwd,
                allowDir: approval.allowDir,
              },
            });
          },
          onReady: () => {
            appendProgressStep({
              id: crypto.randomUUID(),
              name: "agent_model_ready",
              input: {},
            });
          },
          onThinking: handleThinking,
        },
        resolvedRoot,
        llmConfig,
        taskId,
        settings.agentMode,
      );
    } catch (error) {
      const message = formatErrorMessage(error);
      const diagnostics = extractAgentRunDiagnostics(error);
      appendProgressStep({
        id: crypto.randomUUID(),
        name: "agent_error",
        input: {
          message,
          ...(diagnostics ?? {}),
        },
      });
      chat.markMessageError(assistantId, message, chatTabId);
    } finally {
      chat.finalizeMessage(assistantId, chatTabId);
      chat.setAgentRunning(false, chatTabId);
      chat.setActiveTaskId(null, chatTabId);
      await session.persist();
      await this.persistTaskHistory(
        taskId,
        taskTitle,
        chatTabId,
        taskCreatedAt,
        projectRoot,
        chat,
        preview,
        session.current.windowId,
      );
      if (!this.abortRequested) {
        await this.runNextQueuedTask();
      }
    }
  }

  private async persistTaskHistory(
    taskId: string,
    taskTitle: string,
    chatTabId: string,
    createdAt: number,
    projectRoot: string | undefined,
    chat: ReturnType<typeof useChatStore>,
    preview: ReturnType<typeof usePreviewStore>,
    windowId: string,
  ): Promise<void> {
    if (!projectRoot) return;
    const chatSnapshot = chat.exportTabSnapshot(chatTabId);
    if (!chatSnapshot) return;
    const lastMessage = [...chat.messagesForTab(chatTabId)]
      .reverse()
      .find((message) => message.role === "assistant" && message.content.trim());
    try {
      const stored = await loadPartnerSessions(projectRoot);
      const next = upsertPartnerTaskSnapshot(stored, {
        taskId,
        windowId,
        chatTabId,
        title: taskTitle.trim().slice(0, 80) || "未命名任务",
        previewText: lastMessage?.content.trim().replace(/\s+/g, " ").slice(0, 120) ?? "",
        chat: chatSnapshot,
        preview: preview.exportSnapshot(),
        createdAt,
        updatedAt: Date.now(),
      });
      await savePartnerSessions(projectRoot, next);
    } catch (error) {
      console.warn("[SessionHistory] failed to persist task history:", error);
    }
  }

  private async runNextQueuedTask(): Promise<void> {
    const nextTask = this.taskQueue.dequeue();
    if (!nextTask?.text || !nextTask.chatTabId) return;
    await this.runMessage(nextTask.text, nextTask.chatTabId, nextTask.projectRoot, nextTask.title, nextTask.id);
  }

  abort(): void {
    this.abortRequested = true;
    this.taskQueue.clear();
    this.activeInstance?.abort();
    useChatStore().abort();
  }

  gatewayStatus() {
    return this.gateway.status();
  }

  taskQueueSize() {
    return this.taskQueue.size();
  }
}

let orchestrator: Orchestrator | null = null;

export function getOrchestrator(): Orchestrator {
  orchestrator ??= new Orchestrator();
  return orchestrator;
}

export { AgentInstanceRunner } from "./agent-instance.js";
export { Gateway } from "./gateway.js";
export { TaskQueue } from "./task-queue.js";
