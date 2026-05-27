import type { LLMAdapter } from "../adapters/base.js";
import type { RoutingConfig, RoutingTarget } from "../config/types.js";
import type { ContentPart, Usage } from "../types/index.js";

export interface IntentResult {
  level: 0 | 1 | 2 | 3;
  needs_tools: boolean;
  needs_planning: boolean;
  domain: "chat" | "code" | "search" | "writing" | "analysis" | "other";
  reason: string;
}

const CLASSIFIER_PROMPT = `你是一个任务复杂度分类器。分析用户输入，返回 JSON（不要多余内容）：

{
  "level": 0|1|2|3,
  "needs_tools": true|false,
  "needs_planning": true|false,
  "domain": "chat|code|search|writing|analysis|other",
  "reason": "一句话说明判断依据"
}

分级标准：
- L0：闲聊、问候、简单事实问答，不需要工具
- L1：单一明确任务，最多调用 1 个工具
- L2：多步骤任务，需要调用多个工具或有中等推理
- L3：需要深度规划、复杂代码操作、长文档分析、跨多系统操作`;

const DEFAULT_ROUTING: Record<string, RoutingTarget> = {
  l0: { provider: "anthropic", model: "claude-haiku-4-5" },
  l1: { provider: "anthropic", model: "claude-haiku-4-5" },
  l2: { provider: "anthropic", model: "claude-sonnet-4-6" },
  l3: { provider: "anthropic", model: "claude-opus-4-6" },
};

function extractJson(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) return fenced[1].trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end !== -1) return text.slice(start, end + 1);
  return text.trim();
}

export async function classifyIntent(
  input: string,
  adapter: LLMAdapter,
  classifierModel: string,
  onUsage?: (usage: Usage) => void
): Promise<IntentResult> {
  const response = await adapter.complete({
    model: classifierModel,
    max_tokens: 128,
    system: CLASSIFIER_PROMPT,
    messages: [{ role: "user", content: input }],
  });

  if (response.usage && onUsage) onUsage(response.usage);

  const { message } = response;
  const parts: ContentPart[] =
    typeof message.content === "string"
      ? [{ type: "text", text: message.content }]
      : message.content;

  const text = parts
    .filter((p): p is ContentPart & { type: "text" } => p.type === "text")
    .map((p) => p.text)
    .join("");

  return JSON.parse(extractJson(text)) as IntentResult;
}

type LevelRouteKey = "l0" | "l1" | "l2" | "l3";

export function routeTarget(
  intent: IntentResult,
  routing: RoutingConfig
): RoutingTarget {
  const key = `l${intent.level}` as LevelRouteKey;
  return routing[key] ?? DEFAULT_ROUTING[key]!;
}

export function shouldPlan(intent: IntentResult): boolean {
  return intent.level >= 3;
}

/**
 * Classify intent and return the routed provider + model.
 * Falls back to fallback values if classification fails.
 */
export async function resolveModel(
  input: string,
  classifierAdapter: LLMAdapter,
  classifierModel: string,
  routing: RoutingConfig,
  _fallbackProvider: string,
  _fallbackModel: string,
  onUsage?: (usage: Usage) => void
): Promise<{
  model: string;
  provider: string | null;
  intent: IntentResult | null;
}> {
  try {
    const intent = await classifyIntent(
      input,
      classifierAdapter,
      classifierModel,
      onUsage
    );
    const target = routeTarget(intent, routing);
    return { model: target.model, provider: target.provider, intent };
  } catch (err) {
    // Re-throw so the caller can surface the failure rather than silently using default
    throw err;
  }
}
