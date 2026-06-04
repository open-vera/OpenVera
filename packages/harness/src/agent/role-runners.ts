/**
 * Role-based Agent Runners — 每个角色有自己的 system prompt、工具集和行为模式
 *
 * 角色分工：
 *   architect  — 分析需求、设计接口、规划实现方案（只读工具）
 *   engineer   — 编码实现、修改文件（读写工具）
 *   tester     — 编写测试、运行测试、检查覆盖率（读写 + bash）
 *   reviewer   — 代码审查、安全检查、质量评估（只读工具）
 */

import type { LLMAdapter } from "@open-vera/core/adapters";
import type { AgentAssignment, StepResult } from "@open-vera/core/types";
import type { RunAssignmentOptions } from "../runtime/internal.js";
import type { AgentRunner } from "./types.js";

// ── Role definitions ──────────────────────────────────────────────────────

export type AgentRole = "pm" | "architect" | "engineer" | "tester" | "reviewer";

interface RoleConfig {
  name: string;
  system: string;
  maxTurns: number;
  /** Tool names this role is allowed to use (empty = all) */
  allowedTools?: string[];
}

const ROLES: Record<AgentRole, RoleConfig> = {
  pm: {
    name: "📋 产品经理",
    system: `你是一位产品经理。你的职责是：
1. 分析任务描述，明确要做什么、不做什么
2. 拆解功能点，定义优先级（P0/P1/P2）
3. 定义验收标准（什么算"做完了"）
4. 识别边界条件和异常场景
5. 输出结构化需求文档

输出格式：
## 需求摘要
一句话描述

## 功能点
- P0: 核心功能
- P1: 重要功能
- P2: 增强功能

## 验收标准
- [ ] 标准1
- [ ] 标准2

## 边界条件
- 异常输入处理
- 空状态展示
- 错误恢复

你只做需求分析，不写代码。`,
    maxTurns: 5,
    allowedTools: ["read_file", "list_dir", "grep", "glob"],
  },

  architect: {
    name: "🏗️ 架构师",
    system: `你是一位资深软件架构师。你的职责是：
1. 阅读和分析现有代码架构
2. 理解项目规范和约束
3. 设计清晰的接口和模块结构
4. 输出结构化的分析报告

你只做分析和设计，不写实现代码。
输出格式：
- 现有架构摘要
- 接口设计（TypeScript 类型定义）
- 实现方案（文件结构、依赖关系）
- 风险点和注意事项`,
    maxTurns: 8,
    allowedTools: ["read_file", "list_dir", "grep", "glob", "bash"],
  },

  engineer: {
    name: "👨‍💻 工程师",
    system: `你是一位高级 TypeScript 工程师。你的职责是：
1. 根据架构师的设计方案编写实现代码
2. 遵循项目规范：TypeScript strict, ESM, .js 后缀导入
3. 使用类型化错误处理，不 throw new Error(string)
4. 每个文件不超过 300 行，超过则拆分
5. 只写 WHAT 代码，WHY 不明显时才写注释

文件命名：kebab-case.ts
类型命名：PascalCase
函数命名：camelCase
常量命名：UPPER_SNAKE_CASE

你只写实现代码，不写测试。`,
    maxTurns: 10,
    allowedTools: ["read_file", "write_file", "edit_file", "list_dir", "grep", "glob"],
  },

  tester: {
    name: "🧪 测试工程师",
    system: `你是一位专业的测试工程师。你的职责是：
1. 阅读实现代码，理解其功能
2. 编写全面的单元测试（Vitest）
3. 测试文件放在 tests/ 子目录，命名 <module>.test.ts
4. 覆盖所有公共方法、边界条件、错误路径
5. 运行测试并确保全部通过
6. 覆盖率目标 ≥ 90%

测试规范：
- 使用 describe / it / expect
- Mock 仅用于外部 API（LLM adapter、网络请求）
- 不 mock 内部模块
- 每个 it 测试一个行为`,
    maxTurns: 12,
    allowedTools: ["read_file", "write_file", "edit_file", "bash", "grep", "glob", "list_dir"],
  },

  reviewer: {
    name: "🔍 审查员",
    system: `你是一位严格的质量审查员和安全专家。你的职责是：
1. 审查代码质量和规范遵循
2. 检查安全隐患（路径遍历、注入、权限泄露）
3. 验证测试充分性
4. 检查架构违规（如 core 依赖 harness）

审查维度：
- 正确性：逻辑是否正确，边界是否处理
- 安全性：是否有注入、越权、信息泄露风险
- 规范性：是否符合项目编码规范
- 可维护性：代码是否清晰、模块职责是否单一

输出 JSON：
{
  "passed": true/false,
  "score": 0-1,
  "issues": [{"severity": "critical|major|minor", "description": "...", "file": "...", "suggestion": "..."}],
  "summary": "..."
}

你只做审查，不修改代码。`,
    maxTurns: 5,
    allowedTools: ["read_file", "list_dir", "grep", "glob"],
  },
};

// ── RoleAgentRunner ───────────────────────────────────────────────────────

/**
 * Role-specific agent runner. Wraps StreamAgentRunner with a role-specific
 * system prompt and tool restrictions.
 */
export class RoleAgentRunner implements AgentRunner {
  readonly name: string;
  private readonly adapter: LLMAdapter;
  private readonly model: string;
  private readonly systemPrompt: string;
  private readonly allowedTools?: string[];
  private readonly maxTurns: number;

  constructor(adapter: LLMAdapter, model: string, role: AgentRole);
  constructor(adapter: LLMAdapter, model: string, systemPrompt: string, name: string);
  constructor(adapter: LLMAdapter, model: string, roleOrPrompt: AgentRole | string, name?: string) {
    this.adapter = adapter;
    this.model = model;

    if (name !== undefined) {
      // Custom prompt mode (from main.md)
      this.systemPrompt = roleOrPrompt;
      this.name = name;
      this.maxTurns = 10;
      this.allowedTools = undefined;
    } else {
      // Built-in role mode
      const role = ROLES[roleOrPrompt as AgentRole];
      this.systemPrompt = role.system;
      this.name = role.name;
      this.maxTurns = role.maxTurns;
      this.allowedTools = role.allowedTools;
    }
  }

  async run(
    assignment: AgentAssignment,
    options: RunAssignmentOptions
  ): Promise<StepResult> {
    const { streamAgent } = await import("@open-vera/core/agent");
    const bundle = assignment.assignedAgent
      ? options.agentSkillBundles?.[assignment.assignedAgent]
      : undefined;
    const baseTools = bundle?.tools ?? options.tools;
    const system = bundle?.system ?? this.systemPrompt;
    const executors = bundle?.executors ?? options.executors;

    // Build role-specific prompt
    const prompt = [
      `# 角色: ${this.name}`,
      ``,
      `# 任务目标`,
      assignment.goal,
      ``,
      `# 当前步骤`,
      assignment.instruction,
      ``,
      `# 上下文`,
      ...assignment.contextSlices.map((s, i) => `## Context ${i + 1}\n${s}`),
    ].join("\n");

    // Filter tools by role's allowed list
    const tools = this.allowedTools
      ? (baseTools ?? []).filter((t: any) =>
          this.allowedTools!.includes(t.name ?? t)
        )
      : baseTools;

    const toolCalls: StepResult["toolCalls"] = [];

    const output = await streamAgent(
      prompt,
      {
        adapter: this.adapter,
        model: this.model,
        tools,
        system,
        maxTurns: this.maxTurns,
        onToolCall: async (name: string, args: Record<string, unknown>) => {
          let result: string;
          if (executors?.has(name)) {
            result = await executors.get(name)!(args);
          } else if (options.onToolCall) {
            result = await options.onToolCall(name, args);
          } else {
            result = `Tool "${name}" not available for this role`;
          }
          toolCalls.push({ name, arguments: args, result });
          return result;
        },
      },
      () => {} // no streaming callback needed for now
    );

    return {
      flowId: assignment.flowId,
      stepId: assignment.stepId,
      output,
      toolCalls,
    };
  }
}

// ── Factory ───────────────────────────────────────────────────────────────

/**
 * Create an AgentRunnerMap with all role-based runners.
 * The "default" runner is the engineer role.
 */
export function createRoleRunners(
  adapter: LLMAdapter,
  model: string
): Map<string, AgentRunner> {
  const runners = new Map<string, AgentRunner>();

  runners.set("pm", new RoleAgentRunner(adapter, model, "pm"));
  runners.set("architect", new RoleAgentRunner(adapter, model, "architect"));
  runners.set("engineer", new RoleAgentRunner(adapter, model, "engineer"));
  runners.set("tester", new RoleAgentRunner(adapter, model, "tester"));
  runners.set("reviewer", new RoleAgentRunner(adapter, model, "reviewer"));
  runners.set("default", runners.get("engineer")!); // default = engineer

  return runners;
}
