/**
 * Centralized error hierarchy for OpenVera.
 *
 * Every domain error extends {@link VeraError} and carries a machine-readable
 * `code` string.  Callers that need to distinguish error categories can use
 * `instanceof` checks or switch on `error.code`.
 *
 * Guidelines:
 * - Never throw raw `Error` from library code; use one of the subclasses below.
 * - Use `cause` (ES 2022 Error.cause) to preserve the original exception when
 *   wrapping.
 * - Keep messages human-readable; codes are for machines.
 */

// ---------------------------------------------------------------------------
// Base
// ---------------------------------------------------------------------------

export class VeraError extends Error {
  /** Short, stable identifier suitable for logging / metrics. */
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "VeraError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export class ConfigError extends VeraError {
  constructor(message: string, options?: ErrorOptions) {
    super("CONFIG_ERROR", message, options);
    this.name = "ConfigError";
  }
}

// ---------------------------------------------------------------------------
// Git / Worktree
// ---------------------------------------------------------------------------

export class GitError extends VeraError {
  constructor(message: string, options?: ErrorOptions) {
    super("GIT_ERROR", message, options);
    this.name = "GitError";
  }
}

// ---------------------------------------------------------------------------
// Validation (slugs, plan formats, etc.)
// ---------------------------------------------------------------------------

export class ValidationError extends VeraError {
  constructor(message: string, options?: ErrorOptions) {
    super("VALIDATION_ERROR", message, options);
    this.name = "ValidationError";
  }
}

// ---------------------------------------------------------------------------
// Agent / Subagent
// ---------------------------------------------------------------------------

export class AgentError extends VeraError {
  constructor(code: string, message: string, options?: ErrorOptions) {
    super(code, message, options);
    this.name = "AgentError";
  }
}

/** Subagent job already exists. */
export class DuplicateJobError extends AgentError {
  constructor(jobId: string) {
    super("DUPLICATE_JOB", `Job ${jobId} already exists`);
    this.name = "DuplicateJobError";
  }
}

/** Subagent queue is full. */
export class QueueFullError extends AgentError {
  constructor(limit: number) {
    super("QUEUE_FULL", `Queue is full (max ${limit})`);
    this.name = "QueueFullError";
  }
}

/** Remote runner execution failure. */
export class RemoteRunnerError extends AgentError {
  constructor(runnerCmd: string, detail: string) {
    super("REMOTE_RUNNER_ERROR", `Remote runner failed (${runnerCmd}): ${detail}`);
    this.name = "RemoteRunnerError";
  }
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export class OrchestratorError extends VeraError {
  constructor(code: string, message: string, options?: ErrorOptions) {
    super(code, message, options);
    this.name = "OrchestratorError";
  }
}

export class UnknownDependencyError extends OrchestratorError {
  constructor(taskId: string, dep: string) {
    super("UNKNOWN_DEPENDENCY", `Task "${taskId}" depends on unknown task "${dep}"`);
    this.name = "UnknownDependencyError";
  }
}

export class CircularDependencyError extends OrchestratorError {
  constructor(taskId: string) {
    super("CIRCULAR_DEPENDENCY", `Circular dependency detected involving task "${taskId}"`);
    this.name = "CircularDependencyError";
  }
}

// ---------------------------------------------------------------------------
// Runtime (flow state, dispatch, checkpoint)
// ---------------------------------------------------------------------------

export class RuntimeError extends VeraError {
  constructor(code: string, message: string, options?: ErrorOptions) {
    super(code, message, options);
    this.name = "RuntimeError";
  }
}

export class FlowStateError extends RuntimeError {
  constructor(from: string, to: string) {
    super("FLOW_STATE_ERROR", `Illegal flow state transition: ${from} → ${to}`);
    this.name = "FlowStateError";
  }
}

export class DispatchError extends RuntimeError {
  constructor(message: string) {
    super("DISPATCH_ERROR", message);
    this.name = "DispatchError";
  }
}

export class CheckpointConfigError extends RuntimeError {
  constructor() {
    super("CHECKPOINT_CONFIG", "Cannot resume: checkpoint store not configured (set checkpointsDir in RuntimeOptions)");
    this.name = "CheckpointConfigError";
  }
}

export class ForkConfigError extends RuntimeError {
  constructor() {
    super("FORK_CONFIG", "Cannot fork: checkpoint store not configured (set checkpointsDir in RuntimeOptions)");
    this.name = "ForkConfigError";
  }
}

// ---------------------------------------------------------------------------
// Planner
// ---------------------------------------------------------------------------

export class PlannerError extends VeraError {
  constructor(message: string, options?: ErrorOptions) {
    super("PLANNER_ERROR", message, options);
    this.name = "PlannerError";
  }
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export class ToolError extends VeraError {
  constructor(code: string, message: string, options?: ErrorOptions) {
    super(code, message, options);
    this.name = "ToolError";
  }
}

// ---------------------------------------------------------------------------
// Adapter (LLM providers)
// ---------------------------------------------------------------------------

export class AdapterError extends VeraError {
  constructor(code: string, message: string, options?: ErrorOptions) {
    super(code, message, options);
    this.name = "AdapterError";
  }
}

export class AdapterRequestError extends AdapterError {
  constructor(provider: string, status: number, detail?: string) {
    super(
      "ADAPTER_REQUEST_ERROR",
      `${provider} request failed: ${status}${detail ? ` — ${detail}` : ""}`
    );
    this.name = "AdapterRequestError";
  }
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export class SessionError extends VeraError {
  constructor(code: string, message: string, options?: ErrorOptions) {
    super(code, message, options);
    this.name = "SessionError";
  }
}

export class SessionNotFoundError extends SessionError {
  constructor(sessionId: string) {
    super("SESSION_NOT_FOUND", `No replayable session entries found for ${sessionId}`);
    this.name = "SessionNotFoundError";
  }
}

export class SessionNotBranchError extends SessionError {
  constructor(sessionId: string) {
    super("SESSION_NOT_BRANCH", `Session ${sessionId} is not a branch`);
    this.name = "SessionNotBranchError";
  }
}

// ---------------------------------------------------------------------------
// Intent / Routing
// ---------------------------------------------------------------------------

export class IntentError extends VeraError {
  constructor(message: string, options?: ErrorOptions) {
    super("INTENT_ERROR", message, options);
    this.name = "IntentError";
  }
}

// ---------------------------------------------------------------------------
// REPL
// ---------------------------------------------------------------------------

export class ReplError extends VeraError {
  constructor(message: string, options?: ErrorOptions) {
    super("REPL_ERROR", message, options);
    this.name = "ReplError";
  }
}
