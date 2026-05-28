import type { LLMAdapter } from "../../../adapters/base.js";
import { resolveModel } from "../../../intent/classifier.js";
import type { IntentResult } from "../../../intent/classifier.js";
import type { Usage } from "../../../types/index.js";
import type { ReplContext } from "../../context.js";
import type { RoutingInfo } from "../types.js";
import type { RoutingConfig, RoutingTarget } from "../../../config/types.js";

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
type RouteKey = "l0" | "l1" | "l2" | "l3";
const ROUTE_KEYS: RouteKey[] = ["l0", "l1", "l2", "l3"];

function sameTarget(a: RoutingTarget | undefined, b: RoutingTarget): boolean {
  return a?.provider === b.provider && a.model === b.model;
}

function routesCollapseToDefault(
  routing: RoutingConfig,
  defaultTarget: RoutingTarget,
): boolean {
  return ROUTE_KEYS.every((key) => sameTarget(routing[key], defaultTarget));
}

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

  const defaultTarget = { provider: defaultProvider, model: ctx.model };
  if (routesCollapseToDefault(routingCfg, defaultTarget)) {
    return {
      adapter: ctx.adapter,
      model: ctx.model,
      provider: defaultProvider,
      intent: null,
      failed: false,
      uiRouting: { provider: defaultProvider, model: ctx.model, intent: null },
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
      failed: false,
      uiRouting: { provider, model: routed.model, intent: routed.intent },
    };
  } catch (error) {
    return {
      adapter: ctx.adapter,
      model: ctx.model,
      provider: defaultProvider,
      intent: null,
      failed: false,
      error,
      uiRouting: { provider: defaultProvider, model: ctx.model, intent: null },
    };
  }
}
