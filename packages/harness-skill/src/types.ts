// Skill 系统核心类型

import type { Tool } from "@open-vera/core/types";

export type IntentDomain = "chat" | "code" | "search" | "writing" | "analysis" | "other";

export type SkillTrigger =
  | { type: "always" }
  | { type: "domain"; domains: IntentDomain[] }
  | { type: "level"; minLevel: 0 | 1 | 2 | 3 }
  | { type: "needs_tools" }
  | { type: "explicit" };   // 只能通过 /skill <id> 显式激活

export type ToolExecutor = (
  args: Record<string, unknown>
) => Promise<string> | string;

export interface SkillTool {
  definition: Tool;
  executor: ToolExecutor;
}

export interface Skill {
  id: string;
  name: string;
  description: string;
  triggers: SkillTrigger[];
  /** Source file used for lazy loading and diagnostics. */
  sourcePath?: string;
  /** Load the full skill body/tools on demand. */
  load?: () => Skill;
  /** 注入到 system prompt 的文本片段 */
  systemFragment?: string;
  /** 本 skill 携带的工具 */
  tools?: SkillTool[];
}

/** SkillResolver 的输出，直接传给 streamAgent */
export interface SkillBundle {
  /** base system + 各激活 skill 的 systemFragment 拼接 */
  system: string;
  /** 各激活 skill 的工具合并 */
  tools: Tool[];
  /** toolName → executor，供 onToolCall 分发 */
  executors: Map<string, ToolExecutor>;
}

/** intent 的最小接口，供 resolver 判断触发条件 */
export interface IntentSignal {
  domain: IntentDomain;
  level: 0 | 1 | 2 | 3;
  needs_tools: boolean;
  /** 显式激活的 skill id 列表（来自 /skill 命令） */
  explicitIds?: string[];
}
