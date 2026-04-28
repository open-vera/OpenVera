import type { LLMAdapter } from "../adapters/base.js";
import type { ContentPart } from "../types/index.js";

export interface PlanStepDef {
  id: string;
  description: string;
}

const PLAN_SYSTEM = `你是任务规划专家。将用户目标分解为可执行步骤，只返回JSON数组，不要其他内容：
[
  { "id": "step-1", "description": "步骤描述" },
  { "id": "step-2", "description": "步骤描述" }
]

要求：
- 3到6个步骤
- 每步单一、具体、可执行
- 步骤间有逻辑顺序
- 描述简洁（10-30字）`;

function extractJsonArray(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) return fenced[1].trim();
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start !== -1 && end !== -1) return text.slice(start, end + 1);
  return text.trim();
}

export async function generatePlan(
  goal: string,
  adapter: LLMAdapter,
  model: string,
): Promise<PlanStepDef[]> {
  const response = await adapter.complete({
    model,
    max_tokens: 512,
    system: PLAN_SYSTEM,
    messages: [{ role: "user", content: goal }],
  });

  const { message } = response;
  const parts: ContentPart[] =
    typeof message.content === "string"
      ? [{ type: "text", text: message.content }]
      : message.content;

  const text = parts
    .filter((p): p is ContentPart & { type: "text" } => p.type === "text")
    .map((p) => p.text)
    .join("");

  const parsed = JSON.parse(extractJsonArray(text)) as PlanStepDef[];
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("Invalid plan format returned by model");
  }
  return parsed;
}
