import type { GatewayProject } from "@open-vera/gateway";
import {
  appendAssistantMessage,
  appendMessage,
  createConversation,
  getConversation,
} from "./conversation-store.js";
import { runChatCompletion } from "./chat-runtime.js";
import { listMcpTools, simulateMcpToolCall } from "./mcp-runtime.js";
import { searchProjectRag } from "./rag-runtime.js";
import { spawnRun, type SpawnRunRequest, type SpawnRunResponse } from "./runtime-store.js";

export type ManagementAction =
  | "config.edit"
  | "mcp.reload"
  | "skill.reload"
  | "rag.reindex"
  | "channel.connect"
  | "channel.disconnect"
  | "sandbox.test";

export type ExecutionAction =
  | "chat.send"
  | "flow.run"
  | "rag.search"
  | "mcp.tool.call"
  | "sandbox.run";

export interface ActionRequest {
  projectId?: string;
  target?: string;
  payload?: Record<string, unknown>;
}

export interface ActionResult {
  action: ManagementAction | ExecutionAction;
  status: "accepted" | "simulated";
  message: string;
  requestedAt: string;
  projectId?: string;
  target?: string;
  artifactIds: string[];
  traceId: string;
  data?: Record<string, unknown>;
}

export interface ActionContext {
  projects: GatewayProject[];
}

export function runManagementAction(action: ManagementAction, request: ActionRequest): ActionResult {
  return createActionResult(action, request, "accepted", managementMessage(action));
}

export async function runExecutionAction(
  action: ExecutionAction,
  request: ActionRequest,
  context: ActionContext,
): Promise<ActionResult> {
  switch (action) {
    case "chat.send":
      return handleChatSend(request, context);
    case "flow.run":
      return handleFlowRun(request, context);
    case "rag.search":
      return handleRagSearch(request, context);
    case "mcp.tool.call":
      return handleMcpToolCall(request, context);
    default:
      return createActionResult(action, request, "accepted", executionMessage(action));
  }
}

async function handleChatSend(request: ActionRequest, context: ActionContext): Promise<ActionResult> {
  const project = resolveProject(request, context);
  if (!project) {
    return createActionResult("chat.send", request, "accepted", "projectId is required for chat.send");
  }

  const payload = request.payload ?? {};
  const content = typeof payload.message === "string" ? payload.message : typeof payload.content === "string" ? payload.content : "";
  if (!content.trim()) {
    return createActionResult("chat.send", request, "accepted", "message is required in payload");
  }

  let conversationId = typeof payload.conversationId === "string" ? payload.conversationId : undefined;
  if (!conversationId) {
    const created = createConversation(project.id, content.slice(0, 48));
    conversationId = created.id;
  }

  const conversation = getConversation(conversationId);
  if (!conversation) {
    return createActionResult("chat.send", request, "accepted", "Conversation not found");
  }

  const userMessage = appendMessage(conversationId, "user", content);
  if (!userMessage) {
    return createActionResult("chat.send", request, "accepted", "Failed to record message");
  }

  const prior = getConversation(conversationId)?.messages.slice(0, -1) ?? [];
  const completion = await runChatCompletion(project.rootDir, content, prior);
  const assistant = appendAssistantMessage(conversationId, completion.text);

  return createActionResult(
    "chat.send",
    request,
    completion.mode === "llm" ? "accepted" : "simulated",
    completion.mode === "llm" ? "LLM response ready" : completion.text,
    {
    conversationId,
    messageId: userMessage.id,
    assistantMessageId: assistant?.id,
    mode: completion.mode,
    error: completion.error,
    text: completion.text,
    },
  );
}

function handleFlowRun(request: ActionRequest, context: ActionContext): ActionResult {
  const project = resolveProject(request, context);
  if (!project) {
    return createActionResult("flow.run", request, "accepted", "projectId is required for flow.run");
  }

  const payload = request.payload ?? {};
  const spawnRequest: SpawnRunRequest = {
    flowDir: typeof payload.flowDir === "string" ? payload.flowDir : project.rootDir,
    model: typeof payload.model === "string" ? payload.model : undefined,
    provider: typeof payload.provider === "string" ? payload.provider : undefined,
    skipPlanCritique: payload.skipPlanCritique === true,
    maxSteps: typeof payload.maxSteps === "number" ? payload.maxSteps : undefined,
  };

  const started: SpawnRunResponse = spawnRun(spawnRequest, project.rootDir);
  return createActionResult("flow.run", request, "accepted", `Flow run started: ${started.runId}`, {
    runId: started.runId,
    startedAt: started.startedAt,
  });
}

async function handleRagSearch(request: ActionRequest, context: ActionContext): Promise<ActionResult> {
  const project = resolveProject(request, context);
  if (!project) {
    return createActionResult("rag.search", request, "accepted", "projectId is required");
  }
  const payload = request.payload ?? {};
  const query = typeof payload.query === "string" ? payload.query : typeof payload.q === "string" ? payload.q : "";
  const result = await searchProjectRag(project.rootDir, query);
  return createActionResult("rag.search", request, "accepted", result.message ?? `Found ${result.hits.length} hits`, {
    ...result,
  });
}

function handleMcpToolCall(request: ActionRequest, context: ActionContext): ActionResult {
  const project = resolveProject(request, context);
  const payload = request.payload ?? {};
  const serverId = typeof payload.serverId === "string" ? payload.serverId : request.target ?? "unknown";
  const toolName = typeof payload.tool === "string" ? payload.tool : typeof payload.toolName === "string" ? payload.toolName : "unknown";
  const simulated = simulateMcpToolCall(serverId, toolName);
  const tools = project ? listMcpTools(project.rootDir) : [];
  return createActionResult("mcp.tool.call", request, "simulated", simulated.message, { tools, serverId, toolName });
}

function resolveProject(request: ActionRequest, context: ActionContext): GatewayProject | undefined {
  if (request.projectId) {
    return context.projects.find((project) => project.id === request.projectId);
  }
  return context.projects[0];
}

function createActionResult(
  action: ManagementAction | ExecutionAction,
  request: ActionRequest,
  status: ActionResult["status"],
  message: string,
  data?: Record<string, unknown>,
): ActionResult {
  return {
    action,
    status,
    message,
    requestedAt: new Date().toISOString(),
    projectId: request.projectId,
    target: request.target,
    artifactIds: [],
    traceId: `trace-${Date.now().toString(36)}`,
    data,
  };
}

function managementMessage(action: ManagementAction): string {
  switch (action) {
    case "config.edit":
      return "Config edit request accepted; persistence and secret redaction will be handled by Config Manager.";
    case "mcp.reload":
      return "MCP reload request accepted.";
    case "skill.reload":
      return "Skill reload request accepted.";
    case "rag.reindex":
      return "RAG reindex request accepted.";
    case "channel.connect":
      return "Channel connect request accepted.";
    case "channel.disconnect":
      return "Channel disconnect request accepted.";
    case "sandbox.test":
      return "Sandbox test call accepted.";
  }
}

function executionMessage(action: ExecutionAction): string {
  switch (action) {
    case "chat.send":
      return "Chat message accepted.";
    case "flow.run":
      return "Flow run request accepted.";
    case "rag.search":
      return "RAG search request accepted.";
    case "mcp.tool.call":
      return "MCP tool call request accepted.";
    case "sandbox.run":
      return "Sandbox run request accepted.";
  }
}
