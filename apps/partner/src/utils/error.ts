export interface AgentRunDiagnostics {
  taskId?: string;
  requestId?: string;
  sessionId?: string;
  instanceId?: string;
}

export class AgentRunError extends Error {
  readonly diagnostics: AgentRunDiagnostics;

  constructor(message: string, diagnostics: AgentRunDiagnostics = {}) {
    super(message);
    this.name = "AgentRunError";
    this.diagnostics = diagnostics;
  }
}

export function extractAgentRunDiagnostics(error: unknown): AgentRunDiagnostics | null {
  if (error instanceof AgentRunError) {
    return error.diagnostics;
  }
  return null;
}

export function formatAgentRunDiagnostics(diagnostics: AgentRunDiagnostics): string {
  const payload = Object.fromEntries(
    Object.entries(diagnostics).filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === "string" && entry[1].trim().length > 0,
    ),
  );
  if (Object.keys(payload).length === 0) return "";
  return JSON.stringify(payload);
}

export function appendAgentRunDiagnostics(
  message: string,
  diagnostics: AgentRunDiagnostics,
): string {
  const json = formatAgentRunDiagnostics(diagnostics);
  if (!json) return message;
  return `${message}\n\n诊断信息：\n${json}`;
}

export function formatErrorMessage(
  error: unknown,
  fallback = "Agent 运行失败",
): string {
  let message: string;
  if (typeof error === "string" && error.trim().length > 0) {
    if (isSidecarPipeError(error)) {
      message = "Partner 后台服务刚刚断开，已尝试自动重启。请再发送一次。";
    } else if (isApiKeyScenarioMismatch(error)) {
      message = formatApiKeyScenarioMismatch(error);
    } else if (isCacheControlLimitError(error)) {
      message = formatCacheControlLimitError(error);
    } else {
      message = error;
    }
  } else if (error instanceof Error && error.message.trim().length > 0) {
    if (isSidecarPipeError(error.message)) {
      message = "Partner 后台服务刚刚断开，已尝试自动重启。请再发送一次。";
    } else if (isApiKeyScenarioMismatch(error.message)) {
      message = formatApiKeyScenarioMismatch(error.message);
    } else if (isCacheControlLimitError(error.message)) {
      message = formatCacheControlLimitError(error.message);
    } else {
      message = error.message;
    }
  } else {
    message = fallback;
  }

  const diagnostics = extractAgentRunDiagnostics(error);
  if (diagnostics) {
    return appendAgentRunDiagnostics(message, diagnostics);
  }
  return message;
}

function isSidecarPipeError(message: string): boolean {
  return (
    message.includes("Broken pipe") ||
    message.includes("os error 32") ||
    message.includes("sidecar stdin unavailable")
  );
}

function isApiKeyScenarioMismatch(message: string): boolean {
  return (
    message.includes("403") &&
    message.toLowerCase().includes("api key scenario mismatch")
  );
}

function formatApiKeyScenarioMismatch(raw: string): string {
  return [
    "模型服务拒绝了当前请求：API Key 与所选模型/协议场景不匹配。",
    "",
    "请打开设置检查：",
    "1. API Key 是否属于当前 provider/API Base。",
    "2. 协议是否匹配服务类型，例如 Anthropic 官方用 Anthropic，OpenAI 兼容网关用 OpenAI Compatible。",
    "3. 模型 ID 是否是这个 Key 有权限调用的模型。",
    "",
    `原始错误：${raw}`,
  ].join("\n");
}

function isCacheControlLimitError(message: string): boolean {
  const lower = message.toLowerCase();
  return lower.includes("cache_control") && lower.includes("maximum of 4");
}

function formatCacheControlLimitError(raw: string): string {
  return [
    "模型请求参数不合法：Anthropic 最多允许 4 个 cache_control 块。",
    "",
    "Partner 已限制后续请求的缓存块数量；请重试本次消息。",
    "",
    `原始错误：${raw}`,
  ].join("\n");
}
