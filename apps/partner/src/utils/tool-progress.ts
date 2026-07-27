import type { ToolCall } from "@/types";

export type ToolProgressLocale = "zh-CN" | "en-US";

export interface ToolProgressStep {
  id: string;
  category: string;
  title: string;
  detail: string;
  rawName: string;
  rawInput: Record<string, unknown>;
}

export interface ToolProgressGroup {
  category: string;
  title: string;
  steps: ToolProgressStep[];
}

const CATEGORY_TITLES: Record<ToolProgressLocale, Record<string, string>> = {
  "zh-CN": {
    filesystem: "查看项目文件",
    editing: "修改项目文件",
    search: "搜索代码与符号",
    shell: "执行命令",
    git: "检查版本状态",
    lsp: "分析代码结构",
    settings: "读取配置",
    agent: "推进任务",
    approval: "等待授权",
    error: "执行失败",
    other: "执行辅助操作",
  },
  "en-US": {
    filesystem: "Inspect project files",
    editing: "Edit project files",
    search: "Search code and symbols",
    shell: "Run commands",
    git: "Check version state",
    lsp: "Analyze code structure",
    settings: "Read configuration",
    agent: "Advance the task",
    approval: "Await approval",
    error: "Run failed",
    other: "Run helper actions",
  },
};

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function normalizeLocale(locale?: string): ToolProgressLocale {
  return locale?.toLowerCase().startsWith("zh") ? "zh-CN" : "en-US";
}

function inputPath(input: Record<string, unknown>): string | null {
  return asString(input.path) ?? asString(input.filePath) ?? asString(input.target);
}

function inputQuery(input: Record<string, unknown>): string | null {
  return asString(input.query) ?? asString(input.pattern) ?? asString(input.search_term);
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function quoteShellArg(value: string): string {
  if (/^[A-Za-z0-9_./:=@%+-]+$/.test(value)) return value;
  return JSON.stringify(value);
}

export function inputCommand(input: Record<string, unknown>): string | null {
  const command = asString(input.command) ?? asString(input.cmd);
  if (!command) return null;
  const args = asStringArray(input.args);
  return [command, ...args].map(quoteShellArg).join(" ");
}

export function inputCwd(input: Record<string, unknown>): string | null {
  return asString(input.cwd) ?? asString(input.projectRoot);
}

/** One-line preview for compact step lists (collapse newlines / excess spaces). */
export function oneLineText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function isShellProgressStep(step: Pick<ToolProgressStep, "category">): boolean {
  return step.category === "shell" || step.category === "git";
}

const SKIP_PARAM_KEYS = new Set([
  "callId",
  "level",
  "needsTools",
  "needsPlanning",
  "reason",
  "executionMode",
  "domain",
]);

function formatParamValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    return value
      .map((item) => (typeof item === "string" ? quoteShellArg(item) : formatParamValue(item)))
      .join(" ");
  }
  if (value && typeof value === "object") {
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function hasDisplayableParams(input: Record<string, unknown>): boolean {
  return Object.entries(input).some(([key, value]) => {
    if (SKIP_PARAM_KEYS.has(key)) return false;
    if (value == null) return false;
    if (typeof value === "string") return value.trim().length > 0;
    if (Array.isArray(value)) return value.length > 0;
    return true;
  });
}

/** Primary one-line summary for a tool call (command / path / query / …). */
export function primaryToolDetail(step: Pick<ToolProgressStep, "category" | "detail" | "rawInput">): string {
  const command = inputCommand(step.rawInput);
  if (command && isShellProgressStep(step)) return command;
  return (
    inputPath(step.rawInput) ??
    inputQuery(step.rawInput) ??
    command ??
    step.detail
  );
}

/** Full parameter dump for expanded step view. */
export function formatToolParams(input: Record<string, unknown>): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(input)) {
    if (SKIP_PARAM_KEYS.has(key)) continue;
    if (value == null) continue;
    if (typeof value === "string" && !value.trim()) continue;
    if (Array.isArray(value) && value.length === 0) continue;

    const formatted = formatParamValue(value);
    if (formatted.includes("\n")) {
      lines.push(`${key}:`);
      lines.push(formatted);
    } else {
      lines.push(`${key}: ${formatted}`);
    }
  }
  return lines.join("\n");
}

/** Keep expand-all from freezing the UI on huge tool params / outputs. */
export const TOOL_DETAIL_FULL_MAX_CHARS = 4_000;
export const TOOL_RESULT_PREVIEW_MAX_CHARS = 1_200;
/** Compact collapsed panel: a few lines of tool / LLM result. */
export const TOOL_RESULT_COMPACT_PREVIEW_MAX_CHARS = 360;
export const TOOL_RESULT_MARKDOWN_MAX_CHARS = 24_000;

export function truncateDisplayText(text: string, maxChars: number): {
  text: string;
  truncated: boolean;
} {
  if (text.length <= maxChars) {
    return { text, truncated: false };
  }
  return {
    text: `${text.slice(0, maxChars)}\n…`,
    truncated: true,
  };
}

/** Progress-style spam (`Progress: resolved 66, …`) shares a long head. */
const REPEAT_PREFIX_CHARS = 16;
const REPEAT_MIN_RUN = 3;

/**
 * Fold consecutive near-identical lines into the last one plus a count, so a
 * package manager's progress spinner cannot bury the rest of the output.
 */
export function foldRepeatedLines(text: string, suffix = "行相似"): string {
  const lines = text.split("\n");
  if (lines.length < REPEAT_MIN_RUN) return text;
  const folded: string[] = [];
  let runStart = 0;

  const flush = (endExclusive: number) => {
    const count = endExclusive - runStart;
    const last = lines[endExclusive - 1] ?? "";
    if (count >= REPEAT_MIN_RUN) {
      folded.push(`${last}  … ×${count} ${suffix}`);
      return;
    }
    for (let index = runStart; index < endExclusive; index += 1) {
      folded.push(lines[index] ?? "");
    }
  };

  const head = (line: string) => line.trim().slice(0, REPEAT_PREFIX_CHARS);
  for (let index = 1; index <= lines.length; index += 1) {
    const sameRun =
      index < lines.length &&
      head(lines[index] ?? "") !== "" &&
      head(lines[index] ?? "") === head(lines[runStart] ?? "");
    if (sameRun) continue;
    flush(index);
    runStart = index;
  }

  return folded.join("\n");
}

/** One-line result summary for the live (running) progress view. */
export function summarizeResultOutput(
  output: string,
  isError: boolean | undefined,
  locale?: string,
): string {
  const zh = (locale ?? "zh").toLowerCase().startsWith("zh");
  const text = output.trim();
  if (!text) {
    if (isError) return zh ? "失败 · 无输出" : "failed · no output";
    return zh ? "完成 · 无输出" : "done · no output";
  }
  const lines = text.split("\n").filter((line) => line.trim());
  const first = oneLineText(lines[0] ?? "");
  const countLabel = zh ? `${lines.length} 行` : `${lines.length} lines`;
  return lines.length > 1 ? `${countLabel} · ${first}` : first;
}

/**
 * Compact: single-line preview with collapsed whitespace.
 * Full: complete tool params (or short agent label when there are none).
 */
export function formatStepDetail(
  step: ToolProgressStep,
  mode: "compact" | "full",
): string {
  if (step.category === "agent" || step.category === "approval" || step.category === "error") {
    return mode === "compact" ? oneLineText(step.detail) : step.detail;
  }

  const command = inputCommand(step.rawInput);
  if (command && isShellProgressStep(step)) {
    return mode === "compact" ? oneLineText(command) : command;
  }

  if (mode === "compact") {
    return oneLineText(primaryToolDetail(step));
  }

  const full = hasDisplayableParams(step.rawInput)
    ? formatToolParams(step.rawInput)
    : step.detail;
  return truncateDisplayText(full, TOOL_DETAIL_FULL_MAX_CHARS).text;
}

function classifyTool(name: string): string {
  const normalized = name.toLowerCase();
  if (normalized === "agent_error") return "error";
  if (normalized === "tool_approval_required") return "approval";
  if (normalized.startsWith("agent_")) return "agent";
  if (
    normalized.includes("read") ||
    normalized.includes("list") ||
    normalized.includes("glob") ||
    normalized.includes("resource")
  ) {
    return "filesystem";
  }
  if (
    normalized.includes("write") ||
    normalized.includes("edit") ||
    normalized.includes("patch") ||
    normalized.includes("delete")
  ) {
    return "editing";
  }
  if (
    normalized.includes("search") ||
    normalized.includes("grep") ||
    normalized.includes("rg") ||
    normalized.includes("find")
  ) {
    return "search";
  }
  if (
    normalized === "bash" ||
    normalized.includes("shell") ||
    normalized.includes("exec") ||
    normalized.includes("command")
  ) {
    return "shell";
  }
  if (normalized.includes("git")) return "git";
  if (normalized.includes("lsp") || normalized.includes("symbol")) return "lsp";
  if (normalized.includes("setting") || normalized.includes("config")) return "settings";
  if (normalized.includes("agent") || normalized.includes("task")) return "agent";
  return "other";
}

function describeDetail(
  name: string,
  input: Record<string, unknown>,
  category: string,
  locale: ToolProgressLocale,
): string {
  if (name === "agent_start") {
    return locale === "en-US" ? "Starting" : "开始处理";
  }
  if (name === "agent_config") {
    return locale === "en-US" ? "Reading config" : "读取配置";
  }
  if (name === "agent_wait_model") {
    return locale === "en-US" ? "Connecting to model" : "连接模型";
  }
  if (name === "agent_model_ready") {
    return locale === "en-US" ? "Waiting for response" : "等待模型响应";
  }
  if (name === "agent_thinking") {
    return locale === "en-US" ? "Thinking" : "思考中";
  }
  if (name === "agent_intent") {
    const domain = asString(input.domain);
    const domainLabel = domain
      ? locale === "en-US"
        ? domain
        : ({ code: "代码", chat: "对话", other: "通用" }[domain] ?? domain)
      : null;
    const planned = input.executionMode === "harness_plan";
    if (planned) {
      const planLabel = locale === "en-US" ? "plan" : "规划";
      return domainLabel ? `${domainLabel} · ${planLabel}` : planLabel;
    }
    return domainLabel ?? (locale === "en-US" ? "chat" : "对话");
  }
  if (name === "agent_error") {
    const message = asString(input.message);
    const diagnosticJson = [
      asString(input.taskId) ? `taskId=${input.taskId}` : null,
      asString(input.requestId) ? `requestId=${input.requestId}` : null,
      asString(input.sessionId) ? `sessionId=${input.sessionId}` : null,
      asString(input.instanceId) ? `instanceId=${input.instanceId}` : null,
    ].filter(Boolean).join(", ");
    if (!message) {
      return diagnosticJson || (locale === "en-US" ? "Agent run failed" : "Agent 执行失败");
    }
    const headline = message.split("\n").find((line) => line.trim()) ?? message;
    if (diagnosticJson) {
      return locale === "en-US"
        ? `${headline} (${diagnosticJson})`
        : `${headline}（${diagnosticJson}）`;
    }
    return headline;
  }
  if (name === "tool_approval_required") {
    const command = inputCommand(input);
    const reason = asString(input.reason);
    const allowDir = asString(input.allowDir);
    if (command) {
      return locale === "en-US"
        ? `Approval required to run: ${command}`
        : `需要授权执行命令：${command}`;
    }
    if (allowDir) {
      return locale === "en-US"
        ? `Approval required to access: ${allowDir}`
        : `需要授权访问目录：${allowDir}`;
    }
    return reason ?? (locale === "en-US" ? "Tool approval required" : "需要用户授权");
  }

  const path = inputPath(input);
  const query = inputQuery(input);
  const command = inputCommand(input);

  if ((category === "shell" || category === "git") && command) {
    return command;
  }

  if (locale === "en-US") {
    if (category === "search" && query) return `Searched for: ${query}`;
    if (path) return `${CATEGORY_TITLES[locale][category]}: ${path}`;
    return `Used ${name}`;
  }

  if (category === "search" && query) return `搜索：${query}`;
  if (path) return `${CATEGORY_TITLES[locale][category]}：${path}`;
  return `调用 ${name}`;
}

export function summarizeToolCall(
  toolCall: ToolCall,
  locale?: string,
): ToolProgressStep {
  const resolvedLocale = normalizeLocale(locale);
  const category = classifyTool(toolCall.name);
  const title = CATEGORY_TITLES[resolvedLocale][category] ?? CATEGORY_TITLES[resolvedLocale].other;

  return {
    id: toolCall.id,
    category,
    title,
    detail: describeDetail(toolCall.name, toolCall.input, category, resolvedLocale),
    rawName: toolCall.name,
    rawInput: toolCall.input,
  };
}

export function isVisibleToolProgressStep(step: ToolProgressStep): boolean {
  if (step.category === "error") return true;
  return ![
    "agent_start",
    "agent_config",
    "agent_wait_model",
    "agent_model_ready",
  ].includes(step.rawName);
}

export function groupToolProgress(steps: ToolProgressStep[]): ToolProgressGroup[] {
  const groups: ToolProgressGroup[] = [];

  for (const step of steps) {
    const lastGroup = groups.at(-1);
    if (lastGroup?.category === step.category) {
      lastGroup.steps.push(step);
      continue;
    }
    groups.push({
      category: step.category,
      title: step.title,
      steps: [step],
    });
  }

  return groups;
}

export function compactToolProgress(
  groups: ToolProgressGroup[],
  maxGroups = 1,
  maxStepsPerGroup = 3,
): ToolProgressGroup[] {
  if (!groups.length) return [];

  // Trailing agent lifecycle steps (thinking/intent) hide the real tool work —
  // prefer the previous group so the quick preview still surfaces results.
  let end = groups.length;
  const trailing = groups[end - 1];
  if (
    end > 1 &&
    trailing?.category === "agent" &&
    trailing.steps.every((step) => step.rawName !== "agent_error")
  ) {
    end -= 1;
  }

  return groups.slice(Math.max(0, end - maxGroups), end).map((group) => ({
    ...group,
    steps: group.steps.slice(-maxStepsPerGroup),
  }));
}
