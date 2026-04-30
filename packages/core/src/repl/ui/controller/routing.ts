import type { LLMAdapter } from "../../../adapters/base.js";
import { resolveModel } from "../../../intent/classifier.js";
import type { IntentResult } from "../../../intent/classifier.js";
import type { Usage } from "../../../types/index.js";
import type { ReplContext } from "../../context.js";
import type { RoutingInfo } from "../types.js";

export interface ClassifierUsage {
  usage: Usage;
  model: string;
  provider: string;
}

export interface TurnRoutingResult {
  adapter: LLMAdapter;
  model: string;
  provider: string;
  intent: IntentResult | null;
  failed: boolean;
  error?: unknown;
  uiRouting?: RoutingInfo;
}

type ResolveModelFn = typeof resolveModel;

export interface ResolveTurnRoutingOptions {
  line: string;
  ctx: ReplContext;
  onRoutingStart?: () => void;
  onClassifierUsage?: (usage: ClassifierUsage) => void;
  resolveModelFn?: ResolveModelFn;
}

export async function resolveTurnRouting({
  line,
  ctx,
  onRoutingStart,
  onClassifierUsage,
  resolveModelFn = resolveModel,
}: ResolveTurnRoutingOptions): Promise<TurnRoutingResult> {
  const defaultProvider = ctx.config.default_provider ?? "anthropic";
  const routingCfg = ctx.config.routing;
  if (!routingCfg?.enabled) {
    return {
      adapter: ctx.adapter,
      model: ctx.model,
      provider: defaultProvider,
      intent: null,
      failed: false,
    };
  }

  onRoutingStart?.();
  const classifierTarget = routingCfg.classifier;
  const classifierAdapter = classifierTarget ? ctx.buildAdapter(classifierTarget.provider) : ctx.adapter;
  const classifierModel = classifierTarget?.model ?? "claude-haiku-4-5";
  const classifierProvider = classifierTarget?.provider ?? defaultProvider;

  try {
    const routed = await resolveModelFn(
      line,
      classifierAdapter,
      classifierModel,
      routingCfg,
      defaultProvider,
      ctx.model,
      (usage) => onClassifierUsage?.({ usage, model: classifierModel, provider: classifierProvider }),
    );
    const provider = routed.provider ?? defaultProvider;
    return {
      adapter: routed.provider ? ctx.buildAdapter(routed.provider) : ctx.adapter,
      model: routed.model,
      provider,
      intent: routed.intent,
      failed: routed.intent === null,
      uiRouting: { provider, model: routed.model, intent: routed.intent },
    };
  } catch (error) {
    return {
      adapter: ctx.adapter,
      model: ctx.model,
      provider: defaultProvider,
      intent: null,
      failed: true,
      error,
    };
  }
}
