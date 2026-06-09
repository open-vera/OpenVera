import type { LLMAdapter } from "@open-vera/core/adapters";
import type {
  AgentAssignment,
  ArtifactRecord,
  ExecutionPlan,
  PendingAction,
  PolicyProposal,
  RetrospectiveResult,
  StepResult,
  TaskFlow,
  TaskScope,
} from "@open-vera/core/types";
import { writeArtifact } from "./artifacts.js";
import { createApprovalRecord, shouldPauseForApproval } from "./approval.js";
import { buildStepCritiqueOutputs } from "./critique.js";
import {
  checkpointFromFlow,
  createTaskFlow,
  planToArtifact,
  updateFlowState,
  attachArtifacts,
} from "./flow.js";
import { createProposalFromRetrospective } from "./proposal.js";
import { appendTimeline, createArtifactStore } from "./timeline.js";
import type {
  ApprovalDecision,
  ApprovalRecord,
  ArtifactStore,
  AssignmentBundle,
  CheckpointBundle,
  CreateProposalInput,
  FlowHandle,
  FlowLoopEvent,
  FlowLoopResult,
  PlanCritiqueInput,
  PlanDiff,
  ReplanInput,
  RunAssignmentOptions,
  RunFlowLoopOptions,
  RuntimeOptions,
  StartFlowInput,
  StepCritiqueArtifact,
  StepCritiqueInput,
  StepExecutionBundle,
} from "./internal.js";
import type { AgentRunner, AgentRunnerMap } from "../agent/index.js";
import type { PlanFromPromptOptions } from "./planner.js";
import { createHarnessServices, type HarnessServices } from "./services.js";
import { CheckpointStore, makeCheckpointId } from "./checkpoint-store.js";
import type { ResumeOptions, ForkOptions } from "./internal.js";
import { SelfLoopRunner } from "../flow/self-loop.js";
import type { SelfLoopRunnerConfig, SelfLoopResult } from "../flow/self-loop.js";
import type { CriticAgent } from "../critic/critic-agent.js";
import { PluginRegistry } from "../plugin-runtime/registry.js";
import type { PluginRegistryOptions } from "../plugin-runtime/registry.js";
import { createLogger } from "@open-vera/logger";

const log = createLogger("harness:runtime");

function now(): string {
  return new Date().toISOString();
}

async function writeJsonArtifact(
  store: ArtifactStore,
  artifact: ArtifactRecord,
  value: unknown
): Promise<ArtifactRecord> {
  return writeArtifact(store, artifact, JSON.stringify(value, null, 2));
}

function clonePlanWithStepStatus(
  plan: ExecutionPlan | undefined,
  stepId: string,
  status: "pending" | "running" | "done" | "failed" | "blocked"
): ExecutionPlan | undefined {
  if (!plan) return undefined;
  return {
    ...plan,
    steps: plan.steps.map((step) =>
      step.id === stepId ? { ...step, status } : step
    ),
  };
}

function getPendingStepId(plan: ExecutionPlan | undefined): string | undefined {
  return plan?.steps.find((step) => step.status === "pending")?.id;
}

function getDispatchableStepIds(
  plan: ExecutionPlan | undefined,
  limit: number
): string[] {
  if (!plan) return [];
  const doneIds = new Set(
    plan.steps.filter((step) => step.status === "done").map((step) => step.id)
  );
  return plan.steps
    .filter((step) => {
      if (step.status !== "pending") return false;
      return (step.dependsOn ?? []).every((dep) => doneIds.has(dep));
    })
    .slice(0, Math.max(1, limit))
    .map((step) => step.id);
}

/**
 * Detect cycles in step dependency graph via DFS.
 * Returns the cycle path as a string if found, or null if the graph is acyclic.
 */
function detectDependencyCycle(steps: ExecutionPlan["steps"]): string | null {
  const deps = new Map(steps.map((s) => [s.id, s.dependsOn ?? []]));
  const visited = new Set<string>();
  const stack = new Set<string>();

  function dfs(id: string, path: string[]): string | null {
    if (stack.has(id)) return [...path, id].join(" → ");
    if (visited.has(id)) return null;
    visited.add(id);
    stack.add(id);
    for (const dep of deps.get(id) ?? []) {
      const cycle = dfs(dep, [...path, id]);
      if (cycle) return cycle;
    }
    stack.delete(id);
    return null;
  }

  for (const step of steps) {
    const cycle = dfs(step.id, []);
    if (cycle) return cycle;
  }
  return null;
}

function mergeReplannedFlow(
  handle: FlowHandle,
  plan: ExecutionPlan
): FlowHandle {
  return {
    ...handle,
    flow: {
      ...updateFlowState(handle.flow, "dispatching"),
      plan,
      activeStepId: undefined,
    },
  };
}

export class HarnessRuntime {
  private readonly adapter: LLMAdapter;
  private readonly model: string;
  private readonly options: RuntimeOptions;
  private readonly agentRunners: AgentRunnerMap;
  private readonly checkpointStore: import("./checkpoint-store.js").CheckpointStore | null;
  private readonly autoCheckpoint: boolean;
  private readonly services: HarnessServices;
  private readonly registry: PluginRegistry;

  constructor(adapter: LLMAdapter, model: string, options: RuntimeOptions) {
    this.adapter = adapter;
    this.model = model;
    this.options = options;
    this.services = createHarnessServices({
      adapter,
      model,
      llmService: options.llmService,
      provider: options.provider,
      toolHost: options.toolHost,
      toolContext: options.toolContext,
      overrides: options.services,
    });
    this.agentRunners = options.agents ?? new Map<string, AgentRunner>();
    // Ensure a default runner exists
    if (!this.agentRunners.has("default")) {
      this.agentRunners.set("default", this.services.runner.createDefaultRunner());
    }
    // Plugin registry — use provided or create a default one
    this.registry = options.pluginRegistry ?? new PluginRegistry({
      services: { plan: (goal) => this.services.planner.plan(goal) },
    });
    // Checkpoint store — only if checkpointsDir is provided
    if (options.checkpointsDir) {
      this.checkpointStore = new CheckpointStore({ checkpointsDir: options.checkpointsDir });
      this.autoCheckpoint = options.autoCheckpoint !== false;
    } else {
      this.checkpointStore = null;
      this.autoCheckpoint = false;
    }
  }

  private getRunner(assignedAgent?: string): AgentRunner {
    const key = assignedAgent ?? "default";
    const runner = this.agentRunners.get(key) ?? this.agentRunners.get("default")!;
    return runner;
  }

  /** Access the plugin registry (for registering plugins or subscribing to events). */
  getPluginRegistry(): PluginRegistry {
    return this.registry;
  }

  /**
   * Generate an ExecutionPlan from a natural-language goal and start a Flow.
   * This is the "从用户输入到完整执行" entry point — replaces the need to
   * pre-write a Markdown flow file for simple tasks.
   */
  async planAndStart(
    goal: string,
    flowId: string,
    planOptions: PlanFromPromptOptions = {},
    scope?: TaskScope,
    maxLoops?: number,
  ): Promise<FlowHandle> {
    // Hook: beforePlan — allow plugins to rewrite the goal
    const finalGoal = (await this.registry.runHook("beforePlan", goal)) ?? goal;
    const rawPlan = await this.services.planner.plan(finalGoal, planOptions);
    // Hook: afterPlan — allow plugins to modify the plan
    const plan = (await this.registry.runHook("afterPlan", rawPlan)) ?? rawPlan;
    await this.registry.emit("plan:generated", { plan });
    return this.startFlow({ flowId, goal: finalGoal, plan, scope, maxLoops });
  }

  async startFlow(input: StartFlowInput): Promise<FlowHandle> {
    const store = await createArtifactStore(
      this.options.artifactsRootDir,
      input.flowId
    );
    let flow = createTaskFlow(input);

    await appendTimeline(store, {
      ts: now(),
      type: "flow_started",
      flowId: flow.flowId,
    });

    const planArtifact = await writeJsonArtifact(
      store,
      planToArtifact(input.plan),
      input.plan
    );
    flow = attachArtifacts(flow, [planArtifact]);
    flow = updateFlowState(flow, "dispatching");

    await this.registry.emit("flow:start", { flowId: flow.flowId, plan: input.plan });
    return { flow, store };
  }

  dispatchStep(handle: FlowHandle, stepId?: string): AssignmentBundle {
    const plan = handle.flow.plan;
    if (!plan) throw new Error("Cannot dispatch step without plan");

    const cycle = detectDependencyCycle(plan.steps);
    if (cycle) throw new Error(`Circular dependency detected in plan steps: ${cycle}`);

    const doneIds = new Set(
      plan.steps.filter((s) => s.status === "done").map((s) => s.id)
    );

    const step = stepId
      ? plan.steps.find((candidate) => candidate.id === stepId)
      : plan.steps.find((candidate) => {
          if (candidate.status !== "pending") return false;
          return (candidate.dependsOn ?? []).every((dep) => doneIds.has(dep));
        });

    if (!step) throw new Error("No dispatchable step found (all pending steps have unresolved dependencies)");

    const assignment: AgentAssignment = {
      flowId: handle.flow.flowId,
      stepId: step.id,
      goal: handle.flow.goal,
      instruction: step.action,
      allowedTools: [],
      scope: handle.flow.scope,
      contextSlices: [`Plan goal: ${plan.goal}`, `Step type: ${step.type}`],
      assignedAgent: step.assignedAgent,
    };

    const nextFlow = {
      ...handle.flow,
      activeStepId: step.id,
      assignedAgents: step.assignedAgent
        ? [step.assignedAgent]
        : handle.flow.assignedAgents,
      plan: clonePlanWithStepStatus(handle.flow.plan, step.id, "running"),
    };
    const flow =
      handle.flow.state === "executing"
        ? nextFlow
        : updateFlowState(nextFlow, "executing");

    void appendTimeline(handle.store, {
      ts: now(),
      type: "step_dispatched",
      flowId: flow.flowId,
      stepId: step.id,
      agentId: step.assignedAgent ?? "default-agent",
    });

    return {
      handle: { ...handle, flow },
      assignment,
    };
  }

  async runAgentAssignment(
    handle: FlowHandle,
    assignment: AgentAssignment,
    options: RunAssignmentOptions = {}
  ): Promise<StepExecutionBundle> {
    const startMs = Date.now();
    const runner = this.getRunner(assignment.assignedAgent);
    const agentName = assignment.assignedAgent ?? "default";
    log.info("step start", { stepId: assignment.stepId, agent: agentName });
    await this.registry.emit("agent:start", { stepId: assignment.stepId, agent: agentName });
    const result = await runner.run(assignment, options);
    log.info("step done", { stepId: assignment.stepId, duration_ms: Date.now() - startMs, toolCalls: result.toolCalls.length });
    await this.registry.emit("agent:done", {
      stepId: assignment.stepId,
      agent: agentName,
      outputs: result.toolCalls.map((tc) => tc.name),
    });

    const artifact = await writeJsonArtifact(
      handle.store,
      {
        id: `step-result-${assignment.stepId}`,
        type: "step_result",
        summary: assignment.stepId,
      },
      result
    );

    const flow = attachArtifacts(
      updateFlowState(
        {
          ...handle.flow,
          plan: clonePlanWithStepStatus(
            handle.flow.plan,
            assignment.stepId,
            "done"
          ),
        },
        "critiquing"
      ),
      [artifact]
    );

    return {
      handle: { ...handle, flow },
      assignment,
      result,
    };
  }

  async runPlanCritique(
    handle: FlowHandle,
    input: PlanCritiqueInput
  ): Promise<{ handle: FlowHandle; result: StepCritiqueArtifact }> {
    const startMs = Date.now();
    const result = await this.services.critique.critiquePlan(input);
    log.debug("plan critique done", { confidence: result.critique.confidence, duration_ms: Date.now() - startMs });
    await this.registry.emit("plan:challenged", {
      score: result.critique.confidence,
      passed: result.critique.nextAction === "complete",
    });
    const artifact = await writeJsonArtifact(
      handle.store,
      {
        id: `critique-plan-${handle.flow.flowId}`,
        type: "critique",
        summary: "Plan critique",
      },
      result
    );

    const flow = attachArtifacts(handle.flow, [artifact]);
    await appendTimeline(handle.store, {
      ts: now(),
      type: "critique_completed",
      flowId: flow.flowId,
      confidence: result.critique.confidence,
      detail: "plan",
    });

    return { handle: { ...handle, flow }, result };
  }

  async runStepCritique(
    handle: FlowHandle,
    input: StepCritiqueInput
  ): Promise<{ handle: FlowHandle; result: StepCritiqueArtifact }> {
    const startMs = Date.now();
    const result = await this.services.critique.critiqueStep(input);
    log.debug("step critique done", { stepName: input.stepName, confidence: result.critique.confidence, duration_ms: Date.now() - startMs });
    await this.registry.emit("step:challenged", {
      stepId: input.stepName,
      score: result.critique.confidence,
      passed: result.critique.nextAction === "complete",
    });
    const artifact = await writeJsonArtifact(
      handle.store,
      {
        id: `critique-step-${input.stepName}`,
        type: "critique",
        summary: input.stepName,
      },
      result
    );

    const flow = attachArtifacts(handle.flow, [artifact]);
    await appendTimeline(handle.store, {
      ts: now(),
      type: "critique_completed",
      flowId: flow.flowId,
      confidence: result.critique.confidence,
      detail: input.stepName,
    });

    return { handle: { ...handle, flow }, result };
  }

  async runStepRetrospective(
    handle: FlowHandle,
    stepId: string,
    critique: import("@open-vera/core/types").CritiqueResult,
    existingLessons?: string
  ): Promise<{ handle: FlowHandle; result: RetrospectiveResult }> {
    const result = await this.services.critique.retrospective(stepId, critique, existingLessons);
    const artifact = await writeJsonArtifact(
      handle.store,
      {
        id: `retrospective-${stepId}`,
        type: "retrospective",
        summary: stepId,
      },
      result
    );

    const flow = attachArtifacts(handle.flow, [artifact]);
    await appendTimeline(handle.store, {
      ts: now(),
      type: "critique_completed",
      flowId: flow.flowId,
      confidence: critique.confidence,
      detail: `retrospective:${stepId}`,
    });

    return { handle: { ...handle, flow }, result };
  }

  async replanFlow(
    handle: FlowHandle,
    input: ReplanInput
  ): Promise<{ handle: FlowHandle; plan: ExecutionPlan; diff: PlanDiff }> {
    const startMs = Date.now();
    const { plan, diff } = await this.services.critique.replan(input);
    log.info("replan done", { failedStepId: input.failedStepId, duration_ms: Date.now() - startMs, added: diff.added.length, removed: diff.removed.length });
    const artifact = await writeJsonArtifact(
      handle.store,
      {
        id: `plan-replanned-${Date.now()}`,
        type: "plan",
        summary: `replan:${input.failedStepId}`,
      },
      plan
    );

    await appendTimeline(handle.store, {
      ts: now(),
      type: "critique_completed",
      flowId: handle.flow.flowId,
      confidence: input.critique.confidence,
      detail: `replan:${input.failedStepId} preserved=${diff.preserved.length} modified=[${diff.modified.join(",")}] added=[${diff.added.join(",")}] removed=[${diff.removed.join(",")}]`,
    });

    const nextHandle = mergeReplannedFlow(
      {
        ...handle,
        flow: attachArtifacts(handle.flow, [artifact]),
      },
      plan
    );

    return { handle: nextHandle, plan, diff };
  }

  async runFlowLoop(
    initialHandle: FlowHandle,
    options: RunFlowLoopOptions = {}
  ): Promise<FlowLoopResult> {
    const startMs = Date.now();
    let handle = initialHandle;
    const completedSteps: string[] = [];
    const maxSteps = options.maxSteps ?? handle.flow.plan?.steps.length ?? 0;
    const maxParallel = Math.max(1, options.maxParallel ?? 1);

    log.info("flow loop start", { flowId: handle.flow.flowId, maxSteps, maxParallel, goal: handle.flow.goal });

    for (let count = 0; count < maxSteps;) {
      const pendingStepId = getPendingStepId(handle.flow.plan);
      if (!pendingStepId) {
        handle = this.completeFlow(handle);
        return { handle, completedSteps };
      }

      const stepIds = getDispatchableStepIds(
        handle.flow.plan,
        Math.min(maxParallel, maxSteps - count)
      );
      if (stepIds.length === 0) {
        break;
      }
      count += stepIds.length;

      await appendTimeline(handle.store, {
        ts: now(),
        type: "batch_started",
        flowId: handle.flow.flowId,
        stepIds,
        detail: `parallel=${stepIds.length}`,
      });
      options.onEvent?.({ type: "batch_start", stepIds });

      const dispatchedBatch: AssignmentBundle[] = [];
      for (const stepId of stepIds) {
        // Hook: beforeStep — plugins can skip a step by returning false
        const proceed = await this.registry.runHook("beforeStep", stepId);
        if (proceed === false) {
          log.info("step skipped by plugin hook", { stepId });
          continue;
        }

        const dispatched = this.dispatchStep(handle, stepId);
        handle = dispatched.handle;

        const stepReadme = options.stepReadmeByStepId?.[stepId];
        if (stepReadme) {
          dispatched.assignment = {
            ...dispatched.assignment,
            instruction: `${dispatched.assignment.instruction}\n\n## 步骤详细说明\n\n${stepReadme}`,
          };
        }

        options.onEvent?.({ type: "step_start", stepId });
        await this.registry.emit("step:start", {
          stepId,
          agents: dispatched.assignment.assignedAgent
            ? [dispatched.assignment.assignedAgent]
            : ["default"],
        });
        dispatchedBatch.push(dispatched);
      }

      const artifactIdsBefore = new Set(handle.flow.artifacts.map((artifact) => artifact.id));
      const executedBatch = await Promise.all(
        dispatchedBatch.map((dispatched) =>
          this.runAgentAssignment(handle, dispatched.assignment, options)
        )
      );

      let mergedFlow = handle.flow;
      for (const executed of executedBatch) {
        const newArtifacts = executed.handle.flow.artifacts.filter(
          (artifact) => !artifactIdsBefore.has(artifact.id)
        );
        artifactIdsBefore.clear();
        for (const artifact of mergedFlow.artifacts) artifactIdsBefore.add(artifact.id);
        mergedFlow = attachArtifacts(mergedFlow, newArtifacts);
        mergedFlow = {
          ...mergedFlow,
          plan: clonePlanWithStepStatus(
            mergedFlow.plan,
            executed.assignment.stepId,
            "done"
          ),
        };
      }
      handle = {
        ...handle,
        flow: updateFlowState(mergedFlow, "critiquing"),
      };

      for (const executed of executedBatch) {
        const critique = await this.runStepCritique(handle, {
          stepName: executed.assignment.stepId,
          goal: handle.flow.goal,
          stepReadme:
            options.stepReadmeByStepId?.[executed.assignment.stepId] ??
            executed.assignment.instruction,
          customChallengePrompt:
            options.stepPromptByStepId?.[executed.assignment.stepId],
          outputs: buildStepCritiqueOutputs(executed.result),
        });
        handle = critique.handle;

        const nextAction = critique.result.critique.nextAction;
        options.onEvent?.({
          type: "step_result",
          stepId: executed.assignment.stepId,
          score: critique.result.critique.confidence,
          passed: nextAction === "complete",
          nextAction,
        });

        if (nextAction === "complete") {
          completedSteps.push(executed.assignment.stepId);
          await this.registry.emit("step:done", {
            stepId: executed.assignment.stepId,
            result: executed.result,
          });
          // Generate retrospective to capture lessons from this step
          try {
            const retro = await this.runStepRetrospective(
              handle,
              executed.assignment.stepId,
              critique.result.critique
            );
            handle = retro.handle;
          } catch {
            // Retrospective is non-blocking; continue even if it fails
          }
          continue;
        }

        if (nextAction === "ask_human") {
          handle = {
            ...handle,
            flow: updateFlowState(handle.flow, "waiting_approval"),
          };
          await this.autoCheckpointFlow(handle);
          options.onEvent?.({ type: "flow_paused", pausedOnStepId: executed.assignment.stepId });
          return {
            handle,
            completedSteps,
            pausedOnStepId: executed.assignment.stepId,
          };
        }

        if (nextAction === "replan") {
          handle = {
            ...handle,
            flow: updateFlowState(handle.flow, "replanning"),
          };
          const replanned = await this.replanFlow(handle, {
            plan: handle.flow.plan!,
            failedStepId: executed.assignment.stepId,
            critique: critique.result.critique,
            projectContext:
              options.stepReadmeByStepId?.[executed.assignment.stepId] ??
              executed.assignment.instruction,
          });
          handle = replanned.handle;
          await this.autoCheckpointFlow(handle);
          options.onEvent?.({ type: "replan", stepId: executed.assignment.stepId, diff: replanned.diff });
          break;
        }

        if (nextAction === "retry") {
          options.onEvent?.({ type: "step_retry", stepId: executed.assignment.stepId });
          await this.registry.emit("step:rework", {
            stepId: executed.assignment.stepId,
            fixes: critique.result.critique.issues?.map((i: any) => i.description ?? i.issue ?? "") ?? [],
          });
          handle = {
            ...handle,
            flow: {
              ...handle.flow,
              plan: clonePlanWithStepStatus(
                handle.flow.plan,
                executed.assignment.stepId,
                "pending"
              ),
            },
          };
        }
      }

      handle = {
        ...handle,
        flow: {
          ...updateFlowState(handle.flow, "dispatching"),
          activeStepId: undefined,
        },
      };
      await this.autoCheckpointFlow(handle);
    }

    if (!getPendingStepId(handle.flow.plan)) {
      handle = this.completeFlow(handle);
      return { handle, completedSteps };
    }

    const failedHandle = this.failFlow(handle);
    await this.autoCheckpointFlow(failedHandle);
    log.info("flow loop end", { flowId: handle.flow.flowId, duration_ms: Date.now() - startMs, completedSteps: completedSteps.length, failedStepId: handle.flow.activeStepId });
    return {
      handle: failedHandle,
      completedSteps,
      failedStepId: handle.flow.activeStepId,
    };
  }

  async recordApproval(
    handle: FlowHandle,
    action: PendingAction,
    decision: ApprovalDecision
  ): Promise<{ handle: FlowHandle; record: ApprovalRecord }> {
    const record = createApprovalRecord(action, decision);
    const artifact = await writeJsonArtifact(
      handle.store,
      {
        id: `approval-${Date.now()}`,
        type: "checkpoint",
        summary: action.tool,
      },
      record
    );

    let flow = attachArtifacts(handle.flow, [artifact]);
    flow = updateFlowState(
      flow,
      shouldPauseForApproval(record) ? "paused" : "dispatching"
    );

    await appendTimeline(handle.store, {
      ts: now(),
      type: "approval_requested",
      flowId: flow.flowId,
      action: action.tool,
      detail: decision.approved ? "approved" : "rejected",
    });

    return { handle: { ...handle, flow }, record };
  }

  async checkpointFlow(
    handle: FlowHandle,
    checkpointId: string
  ): Promise<CheckpointBundle> {
    const checkpoint = checkpointFromFlow({
      checkpointId,
      flow: handle.flow,
      artifacts: handle.flow.artifacts,
    });

    const artifact = await writeJsonArtifact(
      handle.store,
      {
        id: `checkpoint-${checkpointId}`,
        type: "checkpoint",
        summary: handle.flow.state,
      },
      checkpoint
    );

    // Persist to checkpoint store if available
    if (this.checkpointStore) {
      this.checkpointStore.save(checkpoint);
    }

    return { checkpoint, artifact };
  }

  /**
   * Auto-checkpoint: save current flow state if checkpoint store is configured.
   * Called automatically at step boundaries during runFlowLoop.
   * Returns the checkpointId if saved, null otherwise.
   */
  private async autoCheckpointFlow(handle: FlowHandle): Promise<string | null> {
    if (!this.checkpointStore || !this.autoCheckpoint) return null;
    const checkpointId = makeCheckpointId();
    await this.checkpointFlow(handle, checkpointId);
    return checkpointId;
  }

  /**
   * Resume a flow from a persisted checkpoint.
   * Creates a new FlowHandle with the checkpoint's state and plan.
   * The caller can then call runFlowLoop() to continue execution.
   *
   * @param flowId - The flow ID to resume
   * @param options - Resume options (fromStepId, skipCompleted)
   * @returns A FlowHandle ready for continued execution, or null if no checkpoint found
   */
  async resumeFromCheckpoint(
    flowId: string,
    options: ResumeOptions = {}
  ): Promise<FlowHandle | null> {
    if (!this.checkpointStore) {
      throw new Error("Cannot resume: checkpoint store not configured (set checkpointsDir in RuntimeOptions)");
    }

    const checkpoint = this.checkpointStore.loadLatest(flowId);
    if (!checkpoint) return null;

    const skipCompleted = options.skipCompleted !== false;

    // Determine which step to resume from
    let activeStepId = options.fromStepId ?? checkpoint.activeStepId;
    if (!activeStepId && checkpoint.plan && skipCompleted) {
      const nextPending = checkpoint.plan.steps.find((s) => s.status === "pending");
      activeStepId = nextPending?.id;
    }

    // Reconstruct the TaskFlow from checkpoint
    const flow: TaskFlow = {
      flowId: checkpoint.flowId,
      goal: checkpoint.plan?.goal ?? "",
      state: checkpoint.state === "failed" ? "dispatching" : checkpoint.state,
      plan: checkpoint.plan,
      activeStepId,
      loopCount: checkpoint.loopCount,
      maxLoops: checkpoint.loopCount + 3, // Allow more loops on resume
      budget: checkpoint.budget,
      scope: checkpoint.scope,
      assignedAgents: [],
      artifacts: checkpoint.artifacts ?? [],
    };

    // Create a fresh artifact store pointing at the same directory
    const store = await createArtifactStore(
      this.options.artifactsRootDir,
      flowId
    );

    await appendTimeline(store, {
      ts: now(),
      type: "flow_started",
      flowId,
      detail: `resumed from checkpoint ${checkpoint.checkpointId}`,
    });

    return { flow, store };
  }

  /**
   * Fork a new flow from an existing checkpoint.
   * The new flow shares the same plan but has a new flowId and can diverge.
   *
   * @param flowId - Source flow ID
   * @param forkOptions - Fork options (newFlowId, newGoal, resetSteps)
   * @returns A new FlowHandle for the forked flow, or null if no checkpoint found
   */
  async forkFromCheckpoint(
    flowId: string,
    forkOptions: ForkOptions
  ): Promise<FlowHandle | null> {
    if (!this.checkpointStore) {
      throw new Error("Cannot fork: checkpoint store not configured (set checkpointsDir in RuntimeOptions)");
    }

    const checkpoint = this.checkpointStore.loadLatest(flowId);
    if (!checkpoint || !checkpoint.plan) return null;

    const resetSteps = new Set(forkOptions.resetSteps ?? []);

    // Deep clone the plan and optionally reset steps
    const forkedPlan: ExecutionPlan = {
      ...checkpoint.plan,
      goal: forkOptions.newGoal ?? checkpoint.plan.goal,
      steps: checkpoint.plan.steps.map((step) => ({
        ...step,
        status: resetSteps.has(step.id) ? ("pending" as const) : step.status,
      })),
    };

    const flow: TaskFlow = {
      flowId: forkOptions.newFlowId,
      goal: forkedPlan.goal,
      state: "dispatching",
      plan: forkedPlan,
      activeStepId: forkedPlan.steps.find((s) => s.status === "pending")?.id,
      loopCount: 0,
      maxLoops: checkpoint.loopCount + 3,
      budget: { ...checkpoint.budget, tokensUsed: 0, usdUsed: 0 },
      scope: checkpoint.scope,
      assignedAgents: [],
      artifacts: [],
    };

    const store = await createArtifactStore(
      this.options.artifactsRootDir,
      forkOptions.newFlowId
    );

    await appendTimeline(store, {
      ts: now(),
      type: "flow_started",
      flowId: forkOptions.newFlowId,
      detail: `forked from ${flowId} (checkpoint ${checkpoint.checkpointId})`,
    });

    return { flow, store };
  }

  /**
   * Run a self-loop: multi-cycle plan-execute-critique loop with automatic
   * termination based on confidence, cycles, budget, or duplicate detection.
   *
   * @param handle - Initial FlowHandle (from startFlow or planAndStart)
   * @param config - Self-loop configuration (maxCycles, budgetUsd, etc.)
   * @param critic - Optional CriticAgent for LLM-based critique. If omitted,
   *   uses heuristic critique based on flow completion state.
   * @returns SelfLoopResult with cycles, termination reason, and total cost
   */
  async runSelfLoop(
    handle: FlowHandle,
    config: SelfLoopRunnerConfig = {},
    critic?: CriticAgent
  ): Promise<SelfLoopResult> {
    const runner = new SelfLoopRunner(this, critic, config);
    return runner.run(handle);
  }

  async createProposal(
    handle: FlowHandle,
    rationale: string,
    input: CreateProposalInput
  ): Promise<{ handle: FlowHandle; proposal: PolicyProposal }> {
    const bundle = createProposalFromRetrospective(rationale, input);
    const artifact = await writeJsonArtifact(
      handle.store,
      {
        id: bundle.proposal.proposalId,
        type: "proposal",
        summary: bundle.proposal.category,
      },
      bundle
    );

    const flow = attachArtifacts(handle.flow, [artifact]);
    await appendTimeline(handle.store, {
      ts: now(),
      type: "proposal_created",
      proposalId: bundle.proposal.proposalId,
    });

    return { handle: { ...handle, flow }, proposal: bundle.proposal };
  }

  completeFlow(handle: FlowHandle): FlowHandle {
    const completed = {
      ...handle,
      flow: updateFlowState(handle.flow, "completed"),
    };
    void appendTimeline(handle.store, {
      ts: now(),
      type: "flow_completed",
      flowId: handle.flow.flowId,
    });
    // Final checkpoint on completion
    void this.autoCheckpointFlow(completed);
    // Emit flow:complete (fire-and-forget; result is built from current state)
    void this.registry.emit("flow:complete", {
      flowId: handle.flow.flowId,
      result: {
        completedSteps: handle.flow.plan?.steps
          .filter((s) => s.status === "done")
          .map((s) => s.id) ?? [],
      },
    });
    return completed;
  }

  failFlow(handle: FlowHandle): FlowHandle {
    const failed = {
      ...handle,
      flow: updateFlowState(handle.flow, "failed"),
    };
    void appendTimeline(handle.store, {
      ts: now(),
      type: "flow_completed",
      flowId: handle.flow.flowId,
      detail: "failed",
    });
    // Final checkpoint on failure
    void this.autoCheckpointFlow(failed);
    void this.registry.emit("flow:fail", {
      flowId: handle.flow.flowId,
      error: new Error(`Flow failed at step: ${handle.flow.activeStepId ?? "unknown"}`),
    });
    return failed;
  }

  /**
   * Get the checkpoint store (if configured).
   * Useful for listing checkpoints or querying flow history.
   */
  getCheckpointStore(): import("./checkpoint-store.js").CheckpointStore | null {
    return this.checkpointStore;
  }
}
