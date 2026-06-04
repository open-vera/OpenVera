import { resolve, join } from "node:path";
import { existsSync } from "node:fs";
import { HarnessRuntime } from "../runtime/runtime.js";
import type { FlowLoopEvent, RunFlowLoopOptions } from "../runtime/internal.js";
import { buildCliAdapter } from "./adapter.js";
import { flowDefinitionToPlan } from "./plan.js";
import { createSkillResolver, RegistryToolProvider } from "../skill/index.js";
import type { SkillBundle } from "../skill/index.js";
import { createToolRegistry } from "@open-vera/core/tools";
import { SessionStore } from "@open-vera/core/session";
import { globalVeraDir, loadConfig, isConfigEmpty, projectResourcePath, runSetupWizard, syncExternalResources } from "@open-vera/core/config";
import { loadAgents, createRunnersFromAgents } from "./agent-loader.js";
import { loadFlowDefinition, type FlowAgentDefinition } from "../flow-config/index.js";

export interface FlowRunArgs {
  dir?: string;
  flow?: string;
  model?: string;
  provider?: string;
  apiKey?: string;
  artifactsDir?: string;
  maxSteps?: number;
  skipPlanCritique?: boolean;
}

// ── terminal helpers ──────────────────────────────────────────────────────────

const C = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  gray: "\x1b[90m",
  bold: "\x1b[1m",
};

function ok(msg: string) {
  console.log(`  ${C.green}✓${C.reset} ${msg}`);
}
function fail(msg: string) {
  console.log(`  ${C.red}✗${C.reset} ${msg}`);
}
function info(msg: string) {
  console.log(`  ${msg}`);
}
function dim(msg: string) {
  console.log(`  ${C.gray}${msg}${C.reset}`);
}

// ── main command ──────────────────────────────────────────────────────────────

export async function runFlowCommand(args: FlowRunArgs): Promise<void> {
  const projectDir = resolve(args.dir ?? ".");
  const flowDir = join(projectDir, ".vera", "flows");

  if (!existsSync(flowDir)) {
    console.error(`Error: No .vera/flows/ directory found in ${projectDir}`);
    console.error("Create .vera/flows/flow/<name>/main.md to define a flow.");
    process.exit(1);
  }

  // ── First-run setup wizard ─────────────────────────────────────────────
  let config = loadConfig(undefined, projectDir);
  if (isConfigEmpty(config) && process.stdin.isTTY) {
    syncExternalResources();
    const selectedProvider = await runSetupWizard(projectDir);
    if (selectedProvider) {
      config = loadConfig(undefined, projectDir);
    } else {
      process.exit(1);
    }
  }

  const { adapter, model: defaultModel } = buildCliAdapter(args.provider, args.apiKey, projectDir);
  const model = args.model ?? defaultModel;

  // ── Tool + Skill setup ──────────────────────────────────────────────────────
  const cwd = projectDir;
  const sessionStore = new SessionStore({ cwd });
  const { registry: toolRegistry } = createToolRegistry({ cwd, sessionStore });

  const toolProvider = new RegistryToolProvider(toolRegistry, cwd, sessionStore.sessionId);

  // Load skills: builtin + global (~/.vera/skills/) + project-level (.vera/skills/).
  const userSkillsDir = join(globalVeraDir(), "skills");
  const projectSkillsDir = projectResourcePath(projectDir, "skills");
  const skillResolver = createSkillResolver(toolProvider, userSkillsDir, projectSkillsDir);

  const defaultBundle = skillResolver.resolve(
    { domain: "code", level: 2, needs_tools: true },
    "You are Vera, an AI agent that executes structured workflows."
  );

  const flowInput = await loadFlowDefinition(flowDir, args.flow);

  // ── Agent roles setup ───────────────────────────────────────────────────
  // Load agent definitions from .vera/flows/agents/*/main.md
  const agentDefs = await loadAgents(flowDir);
  let agents: Map<string, import("../agent/types.js").AgentRunner> | undefined;

  if (agentDefs.length > 0) {
    dim(`Loading ${agentDefs.length} agent roles from .vera/flows/agents/...`);
    agents = createRunnersFromAgents(agentDefs, adapter, model);
    for (const def of agentDefs) {
      dim(`  ✓ ${def.id}: ${def.name}${def.model ? ` (model: ${def.model})` : ""}`);
    }
  }

  const runtime = new HarnessRuntime(adapter, model, {
    artifactsRootDir: args.artifactsDir ?? join(flowDir, "iterations", flowInput.name),
    agents,
  });

  const flowId = `iter-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const plan = flowDefinitionToPlan(flowInput, flowId);
  const artifactsBase = args.artifactsDir ?? join(flowDir, "iterations", flowInput.name);
  const agentSkillBundles = buildAgentSkillBundles(agentDefs, skillResolver, defaultBundle);

  console.log("");
  console.log(`  ${C.bold}Vera Harness — Flow Runner${C.reset}`);
  info(`Flow dir:  ${flowDir}`);
  info(`Flow:      ${flowInput.id}`);
  info(`Plan:      ${plan.steps.length} steps — ${plan.goal}`);
  info(`Model:     ${model}`);
  info(`Artifacts: ${join(artifactsBase, flowId)}`);
  console.log("");

  const stepReadmeByStepId: Record<string, string> = {};
  const stepPromptByStepId: Record<string, string> = {};
  for (const stage of flowInput.stages) {
    const definition = flowInput.stageDefinitions.get(stage.stage);
    if (definition) {
      stepReadmeByStepId[stage.id] = definition.body;
      if (definition.exitCriteria) {
        stepPromptByStepId[stage.id] = `请根据以下准出标准评估本步骤的执行结果：\n${definition.exitCriteria}`;
      }
    }
  }

  // Start flow
  let handle = await runtime.startFlow({
    flowId,
    goal: plan.goal,
    plan,
    scope: {
      workdir: resolve(join(projectDir, flowInput.workspaceRel ?? "..")),
    },
  });

  // Plan critique (optional)
  if (!args.skipPlanCritique) {
    dim("Critiquing plan...");
    const planCritique = await runtime.runPlanCritique(handle, {
      plan,
      projectContext: flowInput.rawBody.slice(0, 2000),
    });
    handle = planCritique.handle;

    const score = planCritique.result.critique.confidence;
    const passed = planCritique.result.critique.nextAction === "complete";
    if (passed) {
      ok(`Plan critique passed  score=${score.toFixed(2)}`);
    } else {
      fail(
        `Plan critique: score=${score.toFixed(2)} — ${planCritique.result.critique.rationale}`
      );
      if (score < 0.5) {
        console.error(`\n  Plan score too low, aborting. Fix ${flowInput.filePath} and retry.`);
        process.exit(1);
      }
      info("  Continuing despite warnings...");
    }
    console.log("");
  }

  // Progress tracking
  const totalSteps = plan.steps.length;
  let dispatchCount = 0;

  const loopOptions: RunFlowLoopOptions = {
    maxSteps: args.maxSteps ?? totalSteps * (flowInput.maxRetries + 1),
    maxParallel: flowInput.maxParallel,
    stepReadmeByStepId,
    stepPromptByStepId,
    tools: defaultBundle.tools,
    system: defaultBundle.system,
    executors: defaultBundle.executors,
    agentSkillBundles,
    onEvent: (event: FlowLoopEvent) => {
      switch (event.type) {
        case "step_start":
          dispatchCount++;
          info(
            `[${dispatchCount}/${totalSteps}] ${C.bold}${event.stepId}${C.reset}`
          );
          break;
        case "step_result": {
          const s = event.score.toFixed(2);
          if (event.passed) {
            ok(`  score=${s}`);
          } else {
            fail(`  score=${s}  → ${event.nextAction}`);
          }
          break;
        }
        case "step_retry":
          dim(`    ↺ retry ${event.stepId}`);
          dispatchCount--;
          break;
        case "replan": {
          const { modified, added, removed } = event.diff;
          dim(
            `    ↻ replan  modified=[${modified.join(", ")}]` +
            (added.length ? `  added=[${added.join(", ")}]` : "") +
            (removed.length ? `  removed=[${removed.join(", ")}]` : "")
          );
          dispatchCount = 0;
          break;
        }
        case "flow_paused":
          info(`⏸  Paused at "${event.pausedOnStepId}" — human review needed`);
          break;
      }
    },
  };

  const result = await runtime.runFlowLoop(handle, loopOptions);

  console.log("");
  if (result.failedStepId) {
    fail(`Flow failed at step "${result.failedStepId}"`);
    if (result.completedSteps.length) {
      info(`Completed: ${result.completedSteps.join(", ")}`);
    }
    process.exit(1);
  } else if (result.pausedOnStepId) {
    info(`⏸  Flow paused at "${result.pausedOnStepId}".`);
  } else {
    ok(`Flow completed — ${result.completedSteps.length}/${totalSteps} steps`);
    for (const s of result.completedSteps) {
      dim(`    ✓ ${s}`);
    }
  }
  console.log("");
}

function buildAgentSkillBundles(
  agentDefs: FlowAgentDefinition[],
  skillResolver: ReturnType<typeof createSkillResolver>,
  defaultBundle: SkillBundle
): Record<string, SkillBundle> {
  const bundles: Record<string, SkillBundle> = {};
  for (const def of agentDefs) {
    const hasVisibilityConfig =
      Boolean(def.skills?.length) ||
      Boolean(def.rules?.length) ||
      Boolean(def.mcp?.length);
    if (!hasVisibilityConfig) continue;

    const baseSystem = buildAgentSystem(def);
    bundles[def.id] = def.skills?.length
      ? skillResolver.resolveExplicit(def.skills, baseSystem)
      : {
          system: baseSystem,
          tools: defaultBundle.tools,
          executors: defaultBundle.executors,
        };
  }
  return bundles;
}

function buildAgentSystem(def: FlowAgentDefinition): string {
  const visibility: string[] = [];
  if (def.rules?.length) visibility.push(`Visible rules: ${def.rules.join(", ")}`);
  if (def.mcp?.length) visibility.push(`Visible MCP servers: ${def.mcp.join(", ")}`);
  if (def.skills?.length) visibility.push(`Visible skills: ${def.skills.join(", ")}`);
  return visibility.length
    ? `${def.systemPrompt}\n\n# Visibility\n${visibility.join("\n")}`
    : def.systemPrompt;
}
