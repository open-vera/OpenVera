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

function inputCommand(input: Record<string, unknown>): string | null {
  const command = asString(input.command) ?? asString(input.cmd);
  if (!command) return null;
  const args = asStringArray(input.args);
  return [command, ...args].map(quoteShellArg).join(" ");
}

function inputCwd(input: Record<string, unknown>): string | null {
  return asString(input.cwd) ?? asString(input.projectRoot);
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
  if (normalized.includes("shell") || normalized.includes("exec") || normalized.includes("command")) {
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
  const cwd = inputCwd(input);

  if (locale === "en-US") {
    if ((category === "shell" || category === "git") && command) {
      return cwd ? `Ran command: ${command} (cwd: ${cwd})` : `Ran command: ${command}`;
    }
    if (category === "search" && query) return `Searched for: ${query}`;
    if (path) return `${CATEGORY_TITLES[locale][category]}: ${path}`;
    return `Used ${name}`;
  }

  if ((category === "shell" || category === "git") && command) {
    return cwd ? `运行命令：${command}（目录：${cwd}）` : `运行命令：${command}`;
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
  return groups.slice(-maxGroups).map((group) => ({
    ...group,
    steps: group.steps.slice(-maxStepsPerGroup),
  }));
}
