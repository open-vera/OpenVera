// operation-recorder — 操作回放
//
// 记录操作序列（tool calls），支持重放和调试。
// 特性：
//   - 记录每一步的 tool name、args、result、时间戳、耗时
//   - 序列化为 JSON，可持久化后重放
//   - 支持从指定步骤开始重放、修改参数重放
//   - 与 MultiStepOrchestrator 集成，自动记录编排执行

import type { ToolDef, ToolResult, ToolContext } from "./types.js";
import type {
  StepDefinition,
  ToolResolver,
  OrchestrationResult,
} from "./multi-step-orchestrator.js";
import { MultiStepOrchestrator } from "./multi-step-orchestrator.js";

// ── Types ──────────────────────────────────────────────────────────────────────

/** A single recorded step in an operation sequence */
export interface StepRecord {
  /** Step index (0-based) */
  index: number;
  /** Tool name that was invoked */
  tool: string;
  /** Arguments passed to the tool */
  args: Record<string, unknown>;
  /** Result returned by the tool */
  result: ToolResult;
  /** Unix timestamp when the step started */
  timestamp: number;
  /** Duration of the tool execution in ms */
  durationMs: number;
}

/** A complete operation recording */
export interface OperationRecording {
  /** Unique recording ID */
  id: string;
  /** Human-readable label */
  label: string;
  /** Session ID during which the recording was made */
  sessionId: string;
  /** Recording creation time (Unix ms) */
  createdAt: number;
  /** Total duration of all steps in ms */
  totalDurationMs: number;
  /** Whether the overall operation succeeded */
  ok: boolean;
  /** Ordered list of recorded steps */
  steps: StepRecord[];
}

/** Options for controlling replay behavior */
export interface ReplayOptions {
  /** Start replaying from this step index (0-based, default: 0) */
  startFromStep?: number;
  /** Stop replaying after this step index (inclusive, default: last) */
  stopAtStep?: number;
  /** Override args for specific steps by index */
  argsOverrides?: Map<number, Record<string, unknown>>;
  /** If true, use dry-run mode (tools see ctx.dryRun=true) */
  dryRun?: boolean;
  /** AbortSignal for cancellation */
  signal?: AbortSignal;
}

/** Result of a replay operation */
export interface ReplayResult {
  /** Whether the replay completed successfully */
  ok: boolean;
  /** Steps that were actually replayed */
  steps: StepRecord[];
  /** Total replay duration in ms */
  totalDurationMs: number;
  /** Error message if replay failed */
  error?: string;
}

// ── OperationRecorder ──────────────────────────────────────────────────────────

/**
 * Records tool call sequences for later replay and debugging.
 *
 * Usage:
 *   const recorder = new OperationRecorder("my-task");
 *   const wrappedTool = recorder.wrapTool(myTool, ctx);
 *   const result = await wrappedTool.execute(args, ctx);
 *   const recording = recorder.finish();
 *   // Save recording.toJSON() for later replay
 */
export class OperationRecorder {
  private readonly steps: StepRecord[] = [];
  private readonly sessionId: string;
  private readonly label: string;
  private readonly startTime: number;

  constructor(label: string, sessionId = "unknown") {
    this.label = label;
    this.sessionId = sessionId;
    this.startTime = Date.now();
  }

  /** Wrap a tool to record its executions */
  wrapTool<TArgs>(tool: ToolDef<TArgs>, _ctx: ToolContext): ToolDef<TArgs> {
    const recorder = this;
    return {
      ...tool,
      async execute(args: TArgs, ctx: ToolContext): Promise<ToolResult> {
        const index = recorder.steps.length;
        const timestamp = Date.now();
        const result = await tool.execute(args, ctx);
        const durationMs = Date.now() - timestamp;

        recorder.steps.push({
          index,
          tool: tool.name,
          args: args as Record<string, unknown>,
          result,
          timestamp,
          durationMs,
        });

        return result;
      },
    };
  }

  /** Manually record a step (for use outside wrapTool) */
  record(
    tool: string,
    args: Record<string, unknown>,
    result: ToolResult,
    durationMs: number,
  ): void {
    this.steps.push({
      index: this.steps.length,
      tool,
      args,
      result,
      timestamp: Date.now(),
      durationMs,
    });
  }

  /** Get the current number of recorded steps */
  get stepCount(): number {
    return this.steps.length;
  }

  /** Finish recording and produce an OperationRecording */
  finish(): OperationRecording {
    return {
      id: generateId(),
      label: this.label,
      sessionId: this.sessionId,
      createdAt: this.startTime,
      totalDurationMs: Date.now() - this.startTime,
      ok: this.steps.every((s) => s.result.ok),
      steps: [...this.steps],
    };
  }
}

// ── Replay ─────────────────────────────────────────────────────────────────────

/**
 * Replay a recorded operation sequence using the provided tool resolver.
 *
 * @param recording - The operation recording to replay
 * @param resolveTool - Function to resolve tool names to ToolDef instances
 * @param ctx - Tool context for execution
 * @param options - Replay control options
 */
export async function replay(
  recording: OperationRecording,
  resolveTool: ToolResolver,
  ctx: ToolContext,
  options?: ReplayOptions,
): Promise<ReplayResult> {
  const startTime = Date.now();
  const replayedSteps: StepRecord[] = [];
  const startFrom = options?.startFromStep ?? 0;
  const stopAt = options?.stopAtStep ?? recording.steps.length - 1;

  const replayCtx: ToolContext = {
    ...ctx,
    dryRun: options?.dryRun ?? ctx.dryRun,
    signal: options?.signal ?? ctx.signal,
  };

  for (let i = startFrom; i <= stopAt && i < recording.steps.length; i++) {
    // Check for cancellation
    if (options?.signal?.aborted) {
      return {
        ok: false,
        steps: replayedSteps,
        totalDurationMs: Date.now() - startTime,
        error: "Replay cancelled",
      };
    }

    const recorded = recording.steps[i];
    const tool = resolveTool(recorded.tool);

    if (!tool) {
      return {
        ok: false,
        steps: replayedSteps,
        totalDurationMs: Date.now() - startTime,
        error: `Tool not found: ${recorded.tool} (step ${i})`,
      };
    }

    // Apply args overrides if provided
    const args = options?.argsOverrides?.get(i) ?? recorded.args;

    const stepStart = Date.now();
    try {
      const result = await tool.execute(
        args as Parameters<typeof tool.execute>[0],
        replayCtx,
      );
      const durationMs = Date.now() - stepStart;

      replayedSteps.push({
        index: i,
        tool: recorded.tool,
        args,
        result,
        timestamp: stepStart,
        durationMs,
      });

      if (!result.ok) {
        return {
          ok: false,
          steps: replayedSteps,
          totalDurationMs: Date.now() - startTime,
          error: `Step ${i} (${recorded.tool}) failed: ${result.error?.message ?? result.content}`,
        };
      }
    } catch (err) {
      const durationMs = Date.now() - stepStart;
      const errorResult: ToolResult = {
        ok: false,
        content: "",
        error: {
          code: "EXEC_ERROR",
          message: err instanceof Error ? err.message : String(err),
          retryable: false,
        },
      };

      replayedSteps.push({
        index: i,
        tool: recorded.tool,
        args,
        result: errorResult,
        timestamp: stepStart,
        durationMs,
      });

      return {
        ok: false,
        steps: replayedSteps,
        totalDurationMs: Date.now() - startTime,
        error: `Step ${i} (${recorded.tool}) threw: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  return {
    ok: true,
    steps: replayedSteps,
    totalDurationMs: Date.now() - startTime,
  };
}

// ── Recording Serialization ────────────────────────────────────────────────────

/** Serialize a recording to a JSON string */
export function serializeRecording(recording: OperationRecording): string {
  return JSON.stringify(recording, null, 2);
}

/** Deserialize a recording from a JSON string */
export function deserializeRecording(json: string): OperationRecording {
  const parsed = JSON.parse(json) as OperationRecording;

  // Validate basic structure
  if (!parsed.id || !Array.isArray(parsed.steps)) {
    throw new Error("Invalid recording format: missing id or steps");
  }

  return parsed;
}

// ── Orchestrator with Recording ────────────────────────────────────────────────

/**
 * Extended orchestrator that records all step executions.
 *
 * Wraps the tool resolver to intercept and record each tool call,
 * then produces an OperationRecording alongside the orchestration result.
 */
export async function executeWithRecording(
  steps: StepDefinition[],
  resolveTool: ToolResolver,
  ctx: ToolContext,
  label: string,
  inputArgs?: Record<string, unknown>,
  config?: { globalTimeoutMs?: number; stopOnError?: boolean },
): Promise<{ orchestration: OrchestrationResult; recording: OperationRecording }> {
  const recorder = new OperationRecorder(label, ctx.sessionId);

  // Wrap the tool resolver to record each call
  const recordingResolver: ToolResolver = (name: string) => {
    const tool = resolveTool(name);
    if (!tool) return undefined;
    return recorder.wrapTool(tool, ctx);
  };

  const orchestrator = new MultiStepOrchestrator(config);
  const orchestration = await orchestrator.execute(
    steps,
    recordingResolver,
    ctx,
    inputArgs,
  );

  return {
    orchestration,
    recording: recorder.finish(),
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function generateId(): string {
  return `rec_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
