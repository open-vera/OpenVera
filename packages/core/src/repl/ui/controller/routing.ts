import type { LLMAdapter } from "../../../adapters/base.js";
import { resolveModel } from "../../../intent/classifier.js";
import type { IntentResult } from "../../../intent/classifier.js";
import type { Usage } from "../../../types/index.js";
import type { ReplContext } from "../../context.js";
import type { RoutingInfo } from "../types.js";
import type { RoutingConfig, RoutingTarget } from "../../../config/types.js";
import { resolveClassifierTarget, resolveDefaultTarget, resolveRoutingConfig } from "../../../config/model-tiers.js";

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
type RouteKey = "l0" | "l1" | "l2";
const ROUTE_KEYS: RouteKey[] = ["l0", "l1", "l2"];
const CLASSIFIER_FAILURE_TTL_MS = 60_000;

const classifierFailures = new Map<string, number>();

function classifierFailureKey(provider: string, model: string): string {
  return `${provider}:${model}`;
}

function isClassifierCircuitOpen(provider: string, model: string, now = Date.now()): boolean {
  const retryAfter = classifierFailures.get(classifierFailureKey(provider, model));
  if (retryAfter === undefined) return false;
  if (retryAfter > now) return true;
  classifierFailures.delete(classifierFailureKey(provider, model));
  return false;
}

function recordClassifierFailure(provider: string, model: string, now = Date.now()): void {
  classifierFailures.set(classifierFailureKey(provider, model), now + CLASSIFIER_FAILURE_TTL_MS);
}

export function clearClassifierFailureCircuit(): void {
  classifierFailures.clear();
}

function sameTarget(a: RoutingConfig[RouteKey] | undefined, b: RoutingTarget): boolean {
  if (typeof a === "string") return false;
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
  const defaultTarget = resolveDefaultTarget(ctx.config);
  const defaultProvider = defaultTarget.provider;
  const routingCfg = resolveRoutingConfig(ctx.config);
  if (!routingCfg?.enabled) {
    return {
      adapter: ctx.adapter,
      model: ctx.model,
      provider: defaultProvider,
      intent: null,
      failed: false,
    };
  }

  const activeDefaultTarget = { provider: defaultProvider, model: ctx.model };
  if (routesCollapseToDefault(routingCfg, activeDefaultTarget)) {
    return {
      adapter: ctx.adapter,
      model: ctx.model,
      provider: defaultProvider,
      intent: null,
      failed: false,
      uiRouting: { provider: defaultProvider, model: ctx.model, intent: null },
    };
  }

  const classifierTarget = resolveClassifierTarget({ ...ctx.config, routing: routingCfg }, defaultTarget);
  const classifierAdapter = ctx.buildAdapter(classifierTarget.provider, classifierTarget.model);
  const classifierModel = classifierTarget.model;
  const classifierProvider = classifierTarget.provider;

  if (isClassifierCircuitOpen(classifierProvider, classifierModel)) {
    return {
      adapter: ctx.adapter,
      model: ctx.model,
      provider: defaultProvider,
      intent: null,
      failed: true,
      uiRouting: { provider: defaultProvider, model: ctx.model, intent: null },
    };
  }

  onRoutingStart?.();

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
      adapter: routed.provider ? ctx.buildAdapter(routed.provider, routed.model) : ctx.adapter,
      model: routed.model,
      provider,
      intent: routed.intent,
      failed: false,
      uiRouting: { provider, model: routed.model, intent: routed.intent },
    };
  } catch (error) {
    recordClassifierFailure(classifierProvider, classifierModel);
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
