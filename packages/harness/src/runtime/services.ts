import { LlmService, type LLMAdapter, type LlmPurpose } from "@open-vera/core/adapters";
import type { VeraConfig } from "@open-vera/core/config";
import type { ToolContext } from "@open-vera/core/tools";
import type { CritiqueResult, ExecutionPlan, RetrospectiveResult } from "@open-vera/core/types";
import { StreamAgentRunner } from "../agent/index.js";
import type { AgentRunner } from "../agent/index.js";
import type { ToolHostLike } from "../agent/stream-runner.js";
import {
  critiquePlan,
  critiqueStep,
  generateRetrospective,
  replanWithCritique,
} from "./critique.js";
import type {
  PlanCritiqueInput,
  PlanDiff,
  ReplanInput,
  StepCritiqueArtifact,
  StepCritiqueInput,
} from "./internal.js";
import { planFromPrompt, type PlanFromPromptOptions } from "./planner.js";

export interface HarnessPlannerService {
  plan(goal: string, options?: PlanFromPromptOptions): Promise<ExecutionPlan>;
}

export interface HarnessCritiqueService {
  critiquePlan(input: PlanCritiqueInput): Promise<StepCritiqueArtifact>;
  critiqueStep(input: StepCritiqueInput): Promise<StepCritiqueArtifact>;
  replan(input: ReplanInput): Promise<{ plan: ExecutionPlan; diff: PlanDiff }>;
  retrospective(
    stepId: string,
    critique: CritiqueResult,
    existingLessons?: string,
  ): Promise<RetrospectiveResult>;
}

export interface HarnessRunnerService {
  createDefaultRunner(): AgentRunner;
}

export interface HarnessServices {
  planner: HarnessPlannerService;
  critique: HarnessCritiqueService;
  runner: HarnessRunnerService;
}

export interface CreateHarnessServicesOptions {
  adapter: LLMAdapter;
  model: string;
  llmService?: LlmService;
  provider?: string;
  config?: VeraConfig;
  toolHost?: ToolHostLike;
  toolContext?: Partial<ToolContext>;
  overrides?: Partial<HarnessServices>;
}

export function createHarnessServices(options: CreateHarnessServicesOptions): HarnessServices {
  const llmService = options.llmService ?? (options.config ? new LlmService({ config: options.config }) : undefined);
  const adapterForPurpose = (purpose: LlmPurpose, model: string): LLMAdapter =>
    buildPurposeAdapter(llmService, {
      fallback: options.adapter,
      provider: options.provider,
      model,
      purpose,
    });
  const builtin: HarnessServices = {
    planner: {
      plan: (goal, planOptions = {}) => {
        const model = planOptions.model ?? options.model;
        return planFromPrompt(goal, adapterForPurpose("tool", model), {
          ...planOptions,
          model,
        });
      },
    },
    critique: {
      critiquePlan: (input) => critiquePlan(adapterForPurpose("tool", options.model), options.model, input),
      critiqueStep: (input) => critiqueStep(adapterForPurpose("tool", options.model), options.model, input),
      replan: (input) => replanWithCritique(adapterForPurpose("tool", options.model), options.model, input),
      retrospective: (stepId, critique, existingLessons) =>
        generateRetrospective(adapterForPurpose("tool", options.model), options.model, stepId, critique, existingLessons),
    },
    runner: {
      createDefaultRunner: () =>
        llmService
          ? new StreamAgentRunner({
              llm: llmService,
              provider: options.provider,
              model: options.model,
              purpose: "chat",
              toolHost: options.toolHost,
              toolContext: options.toolContext,
            })
          : new StreamAgentRunner(options.adapter, options.model),
    },
  };

  return {
    planner: options.overrides?.planner ?? builtin.planner,
    critique: options.overrides?.critique ?? builtin.critique,
    runner: options.overrides?.runner ?? builtin.runner,
  };
}

function buildPurposeAdapter(
  llmService: LlmService | undefined,
  options: {
    fallback: LLMAdapter;
    provider?: string;
    model: string;
    purpose: LlmPurpose;
  },
): LLMAdapter {
  const buildAdapter = (llmService as unknown as {
    buildAdapter?: (
      provider?: string,
      model?: string,
      options?: { purpose?: LlmPurpose },
    ) => LLMAdapter;
  } | undefined)?.buildAdapter;
  if (typeof buildAdapter !== "function") {
    return options.fallback;
  }
  return buildAdapter.call(llmService, options.provider, options.model, { purpose: options.purpose });
}
