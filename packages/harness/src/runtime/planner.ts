import type { LLMAdapter } from "@vera/core/adapters";
import type { ExecutionPlan, PlanStep } from "@vera/core/types";
import { completeJson } from "./json.js";

export interface PlanFromPromptOptions {
  /** Available tool names the agent can use (informational, for the LLM). */
  tools?: string[];
  /** Optional context summary to help the planner. */
  contextSummary?: string;
  /** Max JSON parse retries before throwing. Default 2. */
  maxRetries?: number;
  /** LLM model override. Uses the HarnessRuntime model by default. */
  model?: string;
}

function buildPlannerPrompt(
  goal: string,
  tools: string[],
  contextSummary: string,
): string {
  const toolList = tools.length > 0 ? tools.join(", ") : "(use any available tools)";
  const context = contextSummary || "(no additional context)";

  return `你是一个任务规划器。根据目标和上下文，输出一个 JSON 执行计划。

目标：${goal}
可用工具：${toolList}
当前上下文：${context}

输出格式（只输出 JSON，不要解释）：
{
  "planId": "唯一标识",
  "goal": "目标描述",
  "assumptions": ["假设1", "假设2"],
  "steps": [
    {
      "id": "step_1",
      "type": "analyze | tool | delegate | critique | finalize",
      "action": "具体要执行的动作描述",
      "dependsOn": [],
      "assignedAgent": "default"
    }
  ],
  "risk": "low | medium | high"
}

规则：
- 3到6个步骤
- 每步 action 描述具体、可执行
- step type: analyze 用于分析/阅读代码，tool 用于修改/执行操作，finalize 用于收尾验证
- dependsOn 列出本步依赖的前置步骤 id
- 根据任务破坏性评估 risk（只读=low，修改文件=medium，删除/系统操作=high）`;
}

function isValidPlanStep(s: unknown): s is PlanStep {
  if (!s || typeof s !== "object") return false;
  const step = s as Record<string, unknown>;
  return (
    typeof step.id === "string" &&
    typeof step.type === "string" &&
    typeof step.action === "string"
  );
}

function validatePlan(raw: unknown): ExecutionPlan {
  if (!raw || typeof raw !== "object") {
    throw new Error("Planner returned non-object");
  }
  const plan = raw as Record<string, unknown>;

  if (typeof plan.goal !== "string") {
    throw new Error("Planner output missing 'goal' field");
  }
  if (!Array.isArray(plan.steps) || plan.steps.length === 0) {
    throw new Error("Planner output missing or empty 'steps' array");
  }
  for (const step of plan.steps) {
    if (!isValidPlanStep(step)) {
      throw new Error(
        `Invalid step: each step must have id, type, and action. Got: ${JSON.stringify(step)}`,
      );
    }
  }

  return {
    planId:
      typeof plan.planId === "string"
        ? plan.planId
        : `plan-${Date.now()}`,
    goal: plan.goal,
    assumptions: Array.isArray(plan.assumptions)
      ? (plan.assumptions as string[])
      : [],
    steps: (plan.steps as PlanStep[]).map((s, i) => ({
      id: s.id || `step_${i + 1}`,
      type: s.type || "tool",
      action: s.action,
      dependsOn: s.dependsOn ?? [],
      assignedAgent: s.assignedAgent ?? "default",
      status: "pending" as const,
    })),
    risk:
      plan.risk === "low" || plan.risk === "medium" || plan.risk === "high"
        ? plan.risk
        : "medium",
  };
}

/**
 * Generate a structured ExecutionPlan from a natural-language goal.
 *
 * Calls the LLM with a planner system prompt and parses the JSON response.
 * Retries up to `maxRetries` times on JSON parse failure.
 */
export async function planFromPrompt(
  goal: string,
  adapter: LLMAdapter,
  options: PlanFromPromptOptions = {},
): Promise<ExecutionPlan> {
  const model = options.model ?? "claude-sonnet-4-6";
  const maxRetries = options.maxRetries ?? 2;
  const prompt = buildPlannerPrompt(
    goal,
    options.tools ?? [],
    options.contextSummary ?? "",
  );

  let lastError: Error | undefined;
  let retryPrompt = prompt;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const raw = await completeJson<unknown>(adapter, model, retryPrompt, {
        maxTokens: 2048,
      });
      return validatePlan(raw.parsed);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < maxRetries) {
        retryPrompt = `${prompt}\n\n[上一次输出解析失败：${lastError.message}。请确保输出严格符合 JSON 格式，不要添加任何解释文字。]`;
      }
    }
  }

  throw new Error(
    `planFromPrompt failed after ${maxRetries + 1} attempts: ${lastError?.message}`,
  );
}
