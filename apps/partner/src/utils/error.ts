export function formatErrorMessage(
  error: unknown,
  fallback = "Agent 运行失败",
): string {
  if (typeof error === "string" && error.trim().length > 0) {
    if (isSidecarPipeError(error)) {
      return "Partner 后台服务刚刚断开，已尝试自动重启。请再发送一次。";
    }
    if (isApiKeyScenarioMismatch(error)) {
      return formatApiKeyScenarioMismatch(error);
    }
    if (isCacheControlLimitError(error)) {
      return formatCacheControlLimitError(error);
    }
    return error;
  }
  if (error instanceof Error && error.message.trim().length > 0) {
    if (isSidecarPipeError(error.message)) {
      return "Partner 后台服务刚刚断开，已尝试自动重启。请再发送一次。";
    }
    if (isApiKeyScenarioMismatch(error.message)) {
      return formatApiKeyScenarioMismatch(error.message);
    }
    if (isCacheControlLimitError(error.message)) {
      return formatCacheControlLimitError(error.message);
    }
    return error.message;
  }
  return fallback;
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
