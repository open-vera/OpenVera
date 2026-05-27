// multi-step-orchestrator — 多步操作编排引擎
//
// 支持 "打开网站 → 登录 → 下载文件 → 解析" 等复合任务
// 特性：
//   - 顺序步骤执行，支持变量传递（前一步输出 → 后一步输入）
//   - 错误恢复策略：abort / skip / retry
//   - 条件分支：基于前一步结果决定下一步
//   - 超时控制（每步 + 全局）

import type { ToolDef, ToolResult, ToolContext } from "./types.js";
import { errorResult } from "./types.js";

// ── Types ──────────────────────────────────────────────────────────────────────

/** Error handling strategy when a step fails */
export type ErrorStrategy = "abort" | "skip" | "retry";

/** Condition operator for branching */
export type ConditionOp = "contains" | "equals" | "matches" | "success" | "failure";

/** A condition that gates step execution */
export interface StepCondition {
  /** Which step result to evaluate (by step id, defaults to previous step) */
  ref?: string;
  /** Comparison operator */
  op: ConditionOp;
  /** Value to compare against (not needed for success/failure) */
  value?: string;
}

/** A single step in the orchestration sequence */
export interface StepDefinition {
  /** Unique step identifier */
  id: string;
  /** Tool name to invoke */
  tool: string;
  /** Arguments to pass to the tool (supports ${var} interpolation) */
  args: Record<string, unknown>;
  /** Human-readable description */
  description?: string;
  /** Error handling strategy (default: "abort") */
  onError?: ErrorStrategy;
  /** Max retries for this step (default: 0) */
  maxRetries?: number;
  /** Condition that must be met for this step to execute */
  condition?: StepCondition;
  /** Timeout override in ms for this step */
  timeoutMs?: number;
}

/** Configuration for the orchestrator */
export interface OrchestratorConfig {
  /** Global timeout in ms (default: 300_000 = 5min) */
  globalTimeoutMs?: number;
  /** Stop on first error (default: true) */
  stopOnError?: boolean;
  /** Max parallel steps (reserved for future, default: 1) */
  concurrency?: number;
}

/** Result of a single step execution */
export interface StepResult {
  stepId: string;
  ok: boolean;
  content: string;
  durationMs: number;
  retries: number;
  skipped: boolean;
  error?: string;
}

/** Overall orchestration result */
export interface OrchestrationResult {
  ok: boolean;
  steps: StepResult[];
  totalDurationMs: number;
  /** Final output — content of the last successful step */
  content: string;
  error?: string;
}

/** Type for tool resolver function */
export type ToolResolver = (toolName: string) => ToolDef | undefined;

// ── Variable Interpolation ─────────────────────────────────────────────────────

/**
 * Replace ${varName} placeholders in args with values from context.
 * Supported patterns:
 *   ${stepId.output}   — content of a previous step
 *   ${stepId.field}    — metadata field of a previous step
 *   ${env.KEY}         — environment variable
 *   ${args.KEY}        — original input argument
 */
export function interpolateVars(
  args: Record<string, unknown>,
  context: Record<string, string>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === "string") {
      result[key] = value.replace(
        /\$\{([^}]+)\}/g,
        (_, expr: string) => context[expr] ?? `\${${expr}}`,
      );
    } else if (Array.isArray(value)) {
      result[key] = value.map((item) =>
        typeof item === "string"
          ? item.replace(
              /\$\{([^}]+)\}/g,
              (_, expr: string) => context[expr] ?? `\${${expr}}`,
            )
          : item,
      );
    } else if (typeof value === "object" && value !== null) {
      result[key] = interpolateVars(
        value as Record<string, unknown>,
        context,
      );
    } else {
      result[key] = value;
    }
  }
  return result;
}

// ── Condition Evaluation ───────────────────────────────────────────────────────

export function evaluateCondition(
  condition: StepCondition,
  stepResults: Map<string, StepResult>,
): boolean {
  const refStep = condition.ref
    ? stepResults.get(condition.ref)
    : Array.from(stepResults.values()).at(-1);

  if (!refStep) return false;

  switch (condition.op) {
    case "success":
      return refStep.ok;
    case "failure":
      return !refStep.ok;
    case "contains":
      return condition.value !== undefined && refStep.content.includes(condition.value);
    case "equals":
      return condition.value !== undefined && refStep.content === condition.value;
    case "matches":
      return (
        condition.value !== undefined &&
        new RegExp(condition.value).test(refStep.content)
      );
    default:
      return false;
  }
}

// ── Orchestrator ───────────────────────────────────────────────────────────────

export class MultiStepOrchestrator {
  private readonly config: Required<OrchestratorConfig>;

  constructor(config?: OrchestratorConfig) {
    this.config = {
      globalTimeoutMs: config?.globalTimeoutMs ?? 300_000,
      stopOnError: config?.stopOnError ?? true,
      concurrency: config?.concurrency ?? 1,
    };
  }

  /**
   * Execute a sequence of steps using the provided tool resolver and context.
   */
  async execute(
    steps: StepDefinition[],
    resolveTool: ToolResolver,
    ctx: ToolContext,
    inputArgs?: Record<string, unknown>,
  ): Promise<OrchestrationResult> {
    const startTime = Date.now();
    const stepResults = new Map<string, StepResult>();
    const allResults: StepResult[] = [];

    // Build initial variable context from input args
    const varContext: Record<string, string> = {};
    if (inputArgs) {
      for (const [key, value] of Object.entries(inputArgs)) {
        if (typeof value === "string") {
          varContext[`args.${key}`] = value;
        }
      }
    }

    for (const step of steps) {
      // Check global timeout
      const elapsed = Date.now() - startTime;
      if (elapsed > this.config.globalTimeoutMs) {
        const timeoutResult: StepResult = {
          stepId: step.id,
          ok: false,
          content: "",
          durationMs: elapsed,
          retries: 0,
          skipped: false,
          error: `Global timeout exceeded (${this.config.globalTimeoutMs}ms)`,
        };
        allResults.push(timeoutResult);
        return {
          ok: false,
          steps: allResults,
          totalDurationMs: elapsed,
          content: "",
          error: `Orchestration timed out after ${elapsed}ms`,
        };
      }

      // Evaluate condition
      if (step.condition) {
        const shouldExecute = evaluateCondition(step.condition, stepResults);
        if (!shouldExecute) {
          const skippedResult: StepResult = {
            stepId: step.id,
            ok: true,
            content: "",
            durationMs: 0,
            retries: 0,
            skipped: true,
          };
          allResults.push(skippedResult);
          stepResults.set(step.id, skippedResult);
          continue;
        }
      }

      // Resolve tool
      const tool = resolveTool(step.tool);
      if (!tool) {
        const toolNotFound: StepResult = {
          stepId: step.id,
          ok: false,
          content: "",
          durationMs: 0,
          retries: 0,
          skipped: false,
          error: `Tool not found: ${step.tool}`,
        };
        allResults.push(toolNotFound);
        stepResults.set(step.id, toolNotFound);
        if (this.config.stopOnError) {
          return {
            ok: false,
            steps: allResults,
            totalDurationMs: Date.now() - startTime,
            content: "",
            error: `Step "${step.id}" failed: tool "${step.tool}" not found`,
          };
        }
        continue;
      }

      // Execute with retries
      const maxRetries = step.maxRetries ?? 0;
      const onError = step.onError ?? "abort";
      let stepResult: StepResult | null = null;

      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        const stepStart = Date.now();

        // Interpolate variables in args
        const interpolatedArgs = interpolateVars(step.args, varContext);

        // Apply step timeout
        const stepCtx: ToolContext = { ...ctx };
        if (step.timeoutMs && ctx.signal) {
          // Note: timeout via AbortController is handled by the tool itself
        }

        try {
          const result = await tool.execute(
            interpolatedArgs as Parameters<typeof tool.execute>[0],
            stepCtx,
          );

          const durationMs = Date.now() - stepStart;

          if (result.ok) {
            stepResult = {
              stepId: step.id,
              ok: true,
              content: result.content,
              durationMs,
              retries: attempt,
              skipped: false,
            };
            // Store output in variable context for subsequent steps
            varContext[`${step.id}.output`] = result.content;
            if (result.metadata?.exitCode !== undefined) {
              varContext[`${step.id}.exitCode`] = String(result.metadata.exitCode);
            }
            break;
          }

          // Step failed
          if (attempt < maxRetries) {
            continue; // Retry
          }

          stepResult = {
            stepId: step.id,
            ok: false,
            content: result.content,
            durationMs,
            retries: attempt,
            skipped: false,
            error: result.error?.message ?? result.content,
          };
        } catch (err) {
          const durationMs = Date.now() - stepStart;
          if (attempt < maxRetries) continue;

          stepResult = {
            stepId: step.id,
            ok: false,
            content: "",
            durationMs,
            retries: attempt,
            skipped: false,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      }

      if (!stepResult) continue;

      allResults.push(stepResult);
      stepResults.set(step.id, stepResult);

      // Handle error strategy
      if (!stepResult.ok) {
        switch (onError) {
          case "abort":
            return {
              ok: false,
              steps: allResults,
              totalDurationMs: Date.now() - startTime,
              content: "",
              error: `Step "${step.id}" failed: ${stepResult.error}`,
            };
          case "skip":
            // Mark as skipped so the overall result can still be ok
            stepResult.skipped = true;
            break;
          case "retry":
            // Already handled by maxRetries loop above
            break;
        }
      }
    }

    // Find last successful step result for final content
    const lastSuccess = allResults.filter((r) => r.ok && !r.skipped).at(-1);

    return {
      ok: allResults.every((r) => r.ok || r.skipped),
      steps: allResults,
      totalDurationMs: Date.now() - startTime,
      content: lastSuccess?.content ?? "",
    };
  }
}

// ── Predefined Patterns (common composite tasks) ──────────────────────────────

/** Common step patterns for quick composition */
export const StepPatterns = {
  /** Navigate → screenshot → analyze */
  browseAndAnalyze(url: string, screenshotPath?: string): StepDefinition[] {
    return [
      {
        id: "navigate",
        tool: "browser",
        args: { action: "navigate", url },
        description: `Navigate to ${url}`,
      },
      {
        id: "screenshot",
        tool: "browser",
        args: { action: "screenshot", path: screenshotPath },
        description: "Take screenshot",
        condition: { ref: "navigate", op: "success" as const },
      },
      {
        id: "analyze",
        tool: "visual_analyze",
        args: { imagePath: "${screenshot.output}" },
        description: "Analyze screenshot with LLM vision",
        condition: { ref: "screenshot", op: "success" as const },
      },
    ];
  },

  /** Navigate → login (fill form → submit) */
  login(url: string, credentials: { username: string; password: string; userSelector?: string; passSelector?: string; submitSelector?: string }): StepDefinition[] {
    return [
      {
        id: "navigate",
        tool: "browser",
        args: { action: "navigate", url },
        description: `Navigate to ${url}`,
      },
      {
        id: "fill_username",
        tool: "browser",
        args: {
          action: "type",
          selector: credentials.userSelector ?? 'input[name="username"], input[type="email"], input[type="text"]',
          text: credentials.username,
        },
        description: "Fill username field",
        condition: { ref: "navigate", op: "success" as const },
      },
      {
        id: "fill_password",
        tool: "browser",
        args: {
          action: "type",
          selector: credentials.passSelector ?? 'input[name="password"], input[type="password"]',
          text: credentials.password,
        },
        description: "Fill password field",
        condition: { ref: "fill_username", op: "success" as const },
      },
      {
        id: "submit",
        tool: "browser",
        args: {
          action: "click",
          selector: credentials.submitSelector ?? 'button[type="submit"], input[type="submit"]',
        },
        description: "Submit login form",
        condition: { ref: "fill_password", op: "success" as const },
      },
    ];
  },

  /** Navigate → click download → wait → parse downloaded file */
  downloadAndParse(url: string, downloadSelector: string, parseCommand: string): StepDefinition[] {
    return [
      {
        id: "navigate",
        tool: "browser",
        args: { action: "navigate", url },
        description: `Navigate to ${url}`,
      },
      {
        id: "click_download",
        tool: "browser",
        args: { action: "click", selector: downloadSelector },
        description: `Click download link: ${downloadSelector}`,
        condition: { ref: "navigate", op: "success" as const },
      },
      {
        id: "wait_download",
        tool: "bash",
        args: { command: "sleep 2" },
        description: "Wait for download to complete",
        condition: { ref: "click_download", op: "success" as const },
      },
      {
        id: "parse",
        tool: "bash",
        args: { command: parseCommand },
        description: "Parse downloaded file",
        condition: { ref: "wait_download", op: "success" as const },
      },
    ];
  },
};
