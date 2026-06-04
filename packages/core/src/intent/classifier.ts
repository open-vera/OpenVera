import type { LLMAdapter } from "../adapters/base.js";
import type { RoutingConfig, RoutingTarget } from "../config/types.js";
import type { ContentPart, Usage } from "../types/index.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("intent");

export interface IntentResult {
  level: 0 | 1 | 2 | 3;
  needs_tools: boolean;
  needs_planning: boolean;
  domain: "chat" | "code" | "search" | "writing" | "analysis" | "other";
  reason: string;
}

const CLASSIFIER_PROMPT = `Classify the user task.
Return ONLY minified JSON, no markdown, no explanation:
{"level":0,"needs_tools":false,"needs_planning":false,"domain":"chat","reason":"short"}
Rules: level 0=chat/simple answer, 1=single action, 2=multi-step/tool work, 3=complex planning.
domain must be one of chat, code, search, writing, analysis, other.
reason must be 12 words or fewer.`;

const DEFAULT_ROUTING: Record<string, RoutingTarget> = {
  l0: { provider: "anthropic", model: "claude-haiku-4-5" },
  l1: { provider: "anthropic", model: "claude-sonnet-4-6" },
  l2: { provider: "anthropic", model: "claude-opus-4-6" },
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
  const startMs = Date.now();
  const response = await adapter.complete({
    model: classifierModel,
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

  const result = JSON.parse(extractJson(text)) as IntentResult;
  log.debug("intent classified", {
    level: result.level,
    domain: result.domain,
    needs_tools: result.needs_tools,
    duration_ms: Date.now() - startMs,
  });
  return result;
}

type LevelRouteKey = "l0" | "l1" | "l2";

export function routeTarget(
  intent: IntentResult,
  routing: RoutingConfig
): RoutingTarget {
  const key = intent.level >= 2 ? "l2" : (`l${intent.level}` as LevelRouteKey);
  const target = routing[key];
  return typeof target === "string" ? DEFAULT_ROUTING[key]! : target ?? DEFAULT_ROUTING[key]!;
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
