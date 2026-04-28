import { resolve, join } from "node:path";
import { homedir } from "node:os";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { HarnessRuntime } from "../runtime/runtime.js";
import type { FlowLoopEvent, RunFlowLoopOptions } from "../runtime/internal.js";
import { buildCliAdapter } from "./adapter.js";
import { markdownToPlan } from "./plan.js";
import { createSkillResolver, RegistryToolProvider } from "../skill/index.js";
import { createToolRegistry } from "@vera/core/tools";
import { SessionStore } from "@vera/core/session";

export interface FlowRunArgs {
  dir?: string;
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

async function tryReadFile(path: string): Promise<string | undefined> {
  if (existsSync(path)) return readFile(path, "utf-8");
  return undefined;
}

// ── main command ──────────────────────────────────────────────────────────────

export async function runFlowCommand(args: FlowRunArgs): Promise<void> {
  const projectDir = resolve(args.dir ?? ".");
  const flowDir = join(projectDir, ".flow");

  if (!existsSync(flowDir)) {
    console.error(`Error: No .flow/ directory found in ${projectDir}`);
    console.error("Create .flow/flow.md to define a flow.");
    process.exit(1);
  }

  const { adapter, model: defaultModel } = buildCliAdapter(args.provider, args.apiKey);
  const model = args.model ?? defaultModel;

  // ── Tool + Skill setup ──────────────────────────────────────────────────────
  const cwd = projectDir;
  const sessionStore = new SessionStore({ cwd });
  const { registry: toolRegistry } = createToolRegistry({ cwd, sessionStore });

  const toolProvider = new RegistryToolProvider(toolRegistry, cwd, sessionStore.sessionId);

  // Load skills: builtin + project-level (.vera/skills/) + user-level (~/.vera/skills/)
  const projectSkillsDir = join(projectDir, ".vera", "skills");
  const userSkillsDir = join(homedir(), ".vera", "skills");
  const skillResolver = createSkillResolver(toolProvider, projectSkillsDir, userSkillsDir);

  // Build skill bundle for a code-level agent (tools + system fragment)
  const bundle = skillResolver.resolve(
    { domain: "code", level: 2, needs_tools: true },
    "You are Vera, an AI agent that executes structured workflows."
  );

  const runtime = new HarnessRuntime(adapter, model, {
    artifactsRootDir: args.artifactsDir ?? join(flowDir, "iterations"),
  });

  const flowInput = await runtime.loadMarkdownFlow(flowDir);
  const flowId = `iter-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const plan = markdownToPlan(flowInput, flowId);
  const artifactsBase = args.artifactsDir ?? join(flowDir, "iterations");

  console.log("");
  console.log(`  ${C.bold}Vera Harness — Flow Runner${C.reset}`);
  info(`Flow dir:  ${flowDir}`);
  info(`Plan:      ${plan.steps.length} steps — ${plan.goal}`);
  info(`Model:     ${model}`);
  info(`Artifacts: ${join(artifactsBase, flowId)}`);
  console.log("");

  // Load step READMEs (.flow/flows/<step>/README.md)
  const stepReadmeByStepId: Record<string, string> = {};
  for (const step of plan.steps) {
    const readme = await tryReadFile(join(flowDir, step.id, "README.md"));
    if (readme) stepReadmeByStepId[step.id] = readme;
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
      projectContext: flowInput.rawFlowBody.slice(0, 2000),
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
        console.error("\n  Plan score too low, aborting. Fix .flow/flow.md and retry.");
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
    stepReadmeByStepId,
    tools: bundle.tools,
    system: bundle.system,
    executors: bundle.executors,
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
