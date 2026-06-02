/**
 * Comprehensive unit tests for the error hierarchy in errors.ts
 *
 * Covers all 26 error classes: constructor, code, message, name,
 * cause (ErrorOptions), instanceof chains, and edge cases.
 */
import { describe, it, expect } from "vitest";
import {
  VeraError,
  ConfigError,
  GitError,
  ValidationError,
  AgentError,
  DuplicateJobError,
  QueueFullError,
  MaxDepthExceededError,
  RemoteRunnerError,
  OrchestratorError,
  UnknownDependencyError,
  CircularDependencyError,
  RuntimeError,
  FlowStateError,
  DispatchError,
  CheckpointConfigError,
  ForkConfigError,
  PlannerError,
  ToolError,
  AdapterError,
  AdapterRequestError,
  SessionError,
  SessionNotFoundError,
  SessionNotBranchError,
  IntentError,
  ReplError,
} from "../errors.js";

// ── VeraError (base) ──────────────────────────────────────────────────────

describe("VeraError", () => {
  it("should set code, message, and name", () => {
    const err = new VeraError("TEST_CODE", "Something went wrong");
    expect(err.code).toBe("TEST_CODE");
    expect(err.message).toBe("Something went wrong");
    expect(err.name).toBe("VeraError");
  });

  it("should be instanceof Error", () => {
    const err = new VeraError("X", "msg");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(VeraError);
  });

  it("should accept ErrorOptions with cause", () => {
    const cause = new Error("root cause");
    const err = new VeraError("ERR", "wrapped", { cause });
    expect(err.cause).toBe(cause);
  });

  it("should be catchable as Error", () => {
    expect(() => {
      throw new VeraError("CATCH", "catch me");
    }).toThrow("catch me");
  });
});

// ── ConfigError ───────────────────────────────────────────────────────────

describe("ConfigError", () => {
  it("should have fixed code CONFIG_ERROR", () => {
    const err = new ConfigError("bad config");
    expect(err.code).toBe("CONFIG_ERROR");
    expect(err.name).toBe("ConfigError");
  });

  it("should extend VeraError", () => {
    const err = new ConfigError("msg");
    expect(err).toBeInstanceOf(VeraError);
    expect(err).toBeInstanceOf(ConfigError);
    expect(err).toBeInstanceOf(Error);
  });

  it("should propagate cause", () => {
    const cause = new Error("inner");
    const err = new ConfigError("bad", { cause });
    expect(err.cause).toBe(cause);
  });
});

// ── GitError ──────────────────────────────────────────────────────────────

describe("GitError", () => {
  it("should have fixed code GIT_ERROR", () => {
    const err = new GitError("git failed");
    expect(err.code).toBe("GIT_ERROR");
    expect(err.name).toBe("GitError");
  });

  it("should extend VeraError", () => {
    const err = new GitError("msg");
    expect(err).toBeInstanceOf(VeraError);
    expect(err).toBeInstanceOf(GitError);
  });
});

// ── ValidationError ───────────────────────────────────────────────────────

describe("ValidationError", () => {
  it("should have fixed code VALIDATION_ERROR", () => {
    const err = new ValidationError("invalid slug");
    expect(err.code).toBe("VALIDATION_ERROR");
    expect(err.name).toBe("ValidationError");
  });

  it("should extend VeraError", () => {
    const err = new ValidationError("msg");
    expect(err).toBeInstanceOf(VeraError);
    expect(err).toBeInstanceOf(ValidationError);
  });

  it("should accept cause", () => {
    const cause = new Error("nested");
    const err = new ValidationError("bad", { cause });
    expect(err.cause).toBe(cause);
  });
});

// ── AgentError (custom code) ──────────────────────────────────────────────

describe("AgentError", () => {
  it("should accept custom code", () => {
    const err = new AgentError("AGENT_CUSTOM", "agent failed");
    expect(err.code).toBe("AGENT_CUSTOM");
    expect(err.message).toBe("agent failed");
    expect(err.name).toBe("AgentError");
  });

  it("should extend VeraError", () => {
    const err = new AgentError("X", "msg");
    expect(err).toBeInstanceOf(VeraError);
    expect(err).toBeInstanceOf(AgentError);
  });

  it("should accept cause", () => {
    const cause = new Error("root");
    const err = new AgentError("E", "m", { cause });
    expect(err.cause).toBe(cause);
  });
});

// ── DuplicateJobError ────────────────────────────────────────────────────

describe("DuplicateJobError", () => {
  it("should have correct code and message", () => {
    const err = new DuplicateJobError("job-42");
    expect(err.code).toBe("DUPLICATE_JOB");
    expect(err.message).toContain("job-42");
    expect(err.message).toContain("already exists");
    expect(err.name).toBe("DuplicateJobError");
  });

  it("should extend AgentError → VeraError", () => {
    const err = new DuplicateJobError("j1");
    expect(err).toBeInstanceOf(AgentError);
    expect(err).toBeInstanceOf(VeraError);
    expect(err).toBeInstanceOf(DuplicateJobError);
  });
});

// ── QueueFullError ────────────────────────────────────────────────────────

describe("QueueFullError", () => {
  it("should have correct code and message with limit", () => {
    const err = new QueueFullError(10);
    expect(err.code).toBe("QUEUE_FULL");
    expect(err.message).toContain("10");
    expect(err.name).toBe("QueueFullError");
  });

  it("should extend AgentError → VeraError", () => {
    const err = new QueueFullError(5);
    expect(err).toBeInstanceOf(AgentError);
    expect(err).toBeInstanceOf(VeraError);
  });
});

// ── MaxDepthExceededError ─────────────────────────────────────────────────

describe("MaxDepthExceededError", () => {
  it("should include depth and maxDepth in message", () => {
    const err = new MaxDepthExceededError(5, 3);
    expect(err.code).toBe("MAX_DEPTH_EXCEEDED");
    expect(err.message).toContain("5");
    expect(err.message).toContain("3");
    expect(err.name).toBe("MaxDepthExceededError");
  });

  it("should extend AgentError → VeraError", () => {
    const err = new MaxDepthExceededError(2, 1);
    expect(err).toBeInstanceOf(AgentError);
    expect(err).toBeInstanceOf(VeraError);
  });
});

// ── RemoteRunnerError ────────────────────────────────────────────────────

describe("RemoteRunnerError", () => {
  it("should include runnerCmd and detail in message", () => {
    const err = new RemoteRunnerError("python run.py", "connection refused");
    expect(err.code).toBe("REMOTE_RUNNER_ERROR");
    expect(err.message).toContain("python run.py");
    expect(err.message).toContain("connection refused");
    expect(err.name).toBe("RemoteRunnerError");
  });

  it("should extend AgentError → VeraError", () => {
    const err = new RemoteRunnerError("cmd", "e");
    expect(err).toBeInstanceOf(AgentError);
    expect(err).toBeInstanceOf(VeraError);
  });
});

// ── OrchestratorError ────────────────────────────────────────────────────

describe("OrchestratorError", () => {
  it("should accept custom code", () => {
    const err = new OrchestratorError("ORCH_CUSTOM", "orchestration failed");
    expect(err.code).toBe("ORCH_CUSTOM");
    expect(err.name).toBe("OrchestratorError");
  });

  it("should extend VeraError", () => {
    const err = new OrchestratorError("X", "msg");
    expect(err).toBeInstanceOf(VeraError);
    expect(err).toBeInstanceOf(OrchestratorError);
  });

  it("should accept cause", () => {
    const cause = new Error("inner");
    const err = new OrchestratorError("E", "m", { cause });
    expect(err.cause).toBe(cause);
  });
});

// ── UnknownDependencyError ────────────────────────────────────────────────

describe("UnknownDependencyError", () => {
  it("should include taskId and dep in message", () => {
    const err = new UnknownDependencyError("task-1", "task-2");
    expect(err.code).toBe("UNKNOWN_DEPENDENCY");
    expect(err.message).toContain("task-1");
    expect(err.message).toContain("task-2");
    expect(err.name).toBe("UnknownDependencyError");
  });

  it("should extend OrchestratorError → VeraError", () => {
    const err = new UnknownDependencyError("a", "b");
    expect(err).toBeInstanceOf(OrchestratorError);
    expect(err).toBeInstanceOf(VeraError);
  });
});

// ── CircularDependencyError ───────────────────────────────────────────────

describe("CircularDependencyError", () => {
  it("should include taskId in message", () => {
    const err = new CircularDependencyError("task-3");
    expect(err.code).toBe("CIRCULAR_DEPENDENCY");
    expect(err.message).toContain("task-3");
    expect(err.name).toBe("CircularDependencyError");
  });

  it("should extend OrchestratorError → VeraError", () => {
    const err = new CircularDependencyError("t");
    expect(err).toBeInstanceOf(OrchestratorError);
    expect(err).toBeInstanceOf(VeraError);
  });
});

// ── RuntimeError ──────────────────────────────────────────────────────────

describe("RuntimeError", () => {
  it("should accept custom code and message", () => {
    const err = new RuntimeError("RUN_ERR", "runtime failed");
    expect(err.code).toBe("RUN_ERR");
    expect(err.message).toBe("runtime failed");
    expect(err.name).toBe("RuntimeError");
  });

  it("should extend VeraError", () => {
    const err = new RuntimeError("X", "msg");
    expect(err).toBeInstanceOf(VeraError);
    expect(err).toBeInstanceOf(RuntimeError);
  });

  it("should accept cause", () => {
    const cause = new Error("nested");
    const err = new RuntimeError("E", "m", { cause });
    expect(err.cause).toBe(cause);
  });
});

// ── FlowStateError ────────────────────────────────────────────────────────

describe("FlowStateError", () => {
  it("should include from→to in message", () => {
    const err = new FlowStateError("planning", "executing");
    expect(err.code).toBe("FLOW_STATE_ERROR");
    expect(err.message).toBe("Illegal flow state transition: planning → executing");
    expect(err.name).toBe("FlowStateError");
  });

  it("should extend RuntimeError → VeraError", () => {
    const err = new FlowStateError("a", "b");
    expect(err).toBeInstanceOf(RuntimeError);
    expect(err).toBeInstanceOf(VeraError);
  });
});

// ── DispatchError ─────────────────────────────────────────────────────────

describe("DispatchError", () => {
  it("should have code DISPATCH_ERROR", () => {
    const err = new DispatchError("no handler");
    expect(err.code).toBe("DISPATCH_ERROR");
    expect(err.message).toBe("no handler");
    expect(err.name).toBe("DispatchError");
  });

  it("should extend RuntimeError → VeraError", () => {
    const err = new DispatchError("msg");
    expect(err).toBeInstanceOf(RuntimeError);
    expect(err).toBeInstanceOf(VeraError);
  });
});

// ── CheckpointConfigError ─────────────────────────────────────────────────

describe("CheckpointConfigError", () => {
  it("should have fixed code and descriptive message", () => {
    const err = new CheckpointConfigError();
    expect(err.code).toBe("CHECKPOINT_CONFIG");
    expect(err.message).toContain("checkpoint");
    expect(err.message).toContain("checkpointsDir");
    expect(err.name).toBe("CheckpointConfigError");
  });

  it("should extend RuntimeError → VeraError", () => {
    const err = new CheckpointConfigError();
    expect(err).toBeInstanceOf(RuntimeError);
    expect(err).toBeInstanceOf(VeraError);
  });
});

// ── ForkConfigError ───────────────────────────────────────────────────────

describe("ForkConfigError", () => {
  it("should have fixed code and descriptive message", () => {
    const err = new ForkConfigError();
    expect(err.code).toBe("FORK_CONFIG");
    expect(err.message).toContain("fork");
    expect(err.message).toContain("checkpointsDir");
    expect(err.name).toBe("ForkConfigError");
  });

  it("should extend RuntimeError → VeraError", () => {
    const err = new ForkConfigError();
    expect(err).toBeInstanceOf(RuntimeError);
    expect(err).toBeInstanceOf(VeraError);
  });
});

// ── PlannerError ──────────────────────────────────────────────────────────

describe("PlannerError", () => {
  it("should have fixed code PLANNER_ERROR", () => {
    const err = new PlannerError("plan failed");
    expect(err.code).toBe("PLANNER_ERROR");
    expect(err.message).toBe("plan failed");
    expect(err.name).toBe("PlannerError");
  });

  it("should extend VeraError", () => {
    const err = new PlannerError("msg");
    expect(err).toBeInstanceOf(VeraError);
    expect(err).toBeInstanceOf(PlannerError);
  });

  it("should accept cause", () => {
    const cause = new Error("root");
    const err = new PlannerError("msg", { cause });
    expect(err.cause).toBe(cause);
  });
});

// ── ToolError ─────────────────────────────────────────────────────────────

describe("ToolError", () => {
  it("should accept custom code", () => {
    const err = new ToolError("TOOL_EXEC_FAIL", "tool failed");
    expect(err.code).toBe("TOOL_EXEC_FAIL");
    expect(err.name).toBe("ToolError");
  });

  it("should extend VeraError", () => {
    const err = new ToolError("X", "msg");
    expect(err).toBeInstanceOf(VeraError);
    expect(err).toBeInstanceOf(ToolError);
  });

  it("should accept cause", () => {
    const cause = new Error("inner");
    const err = new ToolError("E", "m", { cause });
    expect(err.cause).toBe(cause);
  });
});

// ── AdapterError ──────────────────────────────────────────────────────────

describe("AdapterError", () => {
  it("should accept custom code", () => {
    const err = new AdapterError("ADAPT_ERR", "adapter failed");
    expect(err.code).toBe("ADAPT_ERR");
    expect(err.name).toBe("AdapterError");
  });

  it("should extend VeraError", () => {
    const err = new AdapterError("X", "msg");
    expect(err).toBeInstanceOf(VeraError);
    expect(err).toBeInstanceOf(AdapterError);
  });

  it("should accept cause", () => {
    const cause = new Error("inner");
    const err = new AdapterError("E", "m", { cause });
    expect(err.cause).toBe(cause);
  });
});

// ── AdapterRequestError ───────────────────────────────────────────────────

describe("AdapterRequestError", () => {
  it("should include provider and status in message", () => {
    const err = new AdapterRequestError("anthropic", 429);
    expect(err.code).toBe("ADAPTER_REQUEST_ERROR");
    expect(err.message).toBe("anthropic request failed: 429");
    expect(err.name).toBe("AdapterRequestError");
  });

  it("should include detail when provided", () => {
    const err = new AdapterRequestError("openai", 500, "Internal error");
    expect(err.code).toBe("ADAPTER_REQUEST_ERROR");
    expect(err.message).toBe("openai request failed: 500 — Internal error");
  });

  it("should extend AdapterError → VeraError", () => {
    const err = new AdapterRequestError("p", 200);
    expect(err).toBeInstanceOf(AdapterError);
    expect(err).toBeInstanceOf(VeraError);
  });
});

// ── SessionError ──────────────────────────────────────────────────────────

describe("SessionError", () => {
  it("should accept custom code", () => {
    const err = new SessionError("SESS_ERR", "session failed");
    expect(err.code).toBe("SESS_ERR");
    expect(err.name).toBe("SessionError");
  });

  it("should extend VeraError", () => {
    const err = new SessionError("X", "msg");
    expect(err).toBeInstanceOf(VeraError);
    expect(err).toBeInstanceOf(SessionError);
  });

  it("should accept cause", () => {
    const cause = new Error("inner");
    const err = new SessionError("E", "m", { cause });
    expect(err.cause).toBe(cause);
  });
});

// ── SessionNotFoundError ──────────────────────────────────────────────────

describe("SessionNotFoundError", () => {
  it("should include sessionId in message", () => {
    const err = new SessionNotFoundError("sess-abc-123");
    expect(err.code).toBe("SESSION_NOT_FOUND");
    expect(err.message).toContain("sess-abc-123");
    expect(err.name).toBe("SessionNotFoundError");
  });

  it("should extend SessionError → VeraError", () => {
    const err = new SessionNotFoundError("s");
    expect(err).toBeInstanceOf(SessionError);
    expect(err).toBeInstanceOf(VeraError);
  });
});

// ── SessionNotBranchError ─────────────────────────────────────────────────

describe("SessionNotBranchError", () => {
  it("should include sessionId in message", () => {
    const err = new SessionNotBranchError("sess-xyz");
    expect(err.code).toBe("SESSION_NOT_BRANCH");
    expect(err.message).toContain("sess-xyz");
    expect(err.message).toContain("not a branch");
    expect(err.name).toBe("SessionNotBranchError");
  });

  it("should extend SessionError → VeraError", () => {
    const err = new SessionNotBranchError("s");
    expect(err).toBeInstanceOf(SessionError);
    expect(err).toBeInstanceOf(VeraError);
  });
});

// ── IntentError ───────────────────────────────────────────────────────────

describe("IntentError", () => {
  it("should have fixed code INTENT_ERROR", () => {
    const err = new IntentError("intent routing failed");
    expect(err.code).toBe("INTENT_ERROR");
    expect(err.name).toBe("IntentError");
  });

  it("should extend VeraError", () => {
    const err = new IntentError("msg");
    expect(err).toBeInstanceOf(VeraError);
    expect(err).toBeInstanceOf(IntentError);
  });

  it("should accept cause", () => {
    const cause = new Error("inner");
    const err = new IntentError("msg", { cause });
    expect(err.cause).toBe(cause);
  });
});

// ── ReplError ─────────────────────────────────────────────────────────────

describe("ReplError", () => {
  it("should have fixed code REPL_ERROR", () => {
    const err = new ReplError("REPL command failed");
    expect(err.code).toBe("REPL_ERROR");
    expect(err.name).toBe("ReplError");
  });

  it("should extend VeraError", () => {
    const err = new ReplError("msg");
    expect(err).toBeInstanceOf(VeraError);
    expect(err).toBeInstanceOf(ReplError);
  });

  it("should accept cause", () => {
    const cause = new Error("inner");
    const err = new ReplError("msg", { cause });
    expect(err.cause).toBe(cause);
  });
});

// ── Cross-hierarchy instanceof checks ─────────────────────────────────────

describe("Error hierarchy cross-checks", () => {
  it("should NOT mix unrelated branches", () => {
    const configErr = new ConfigError("x");
    const agentErr = new AgentError("X", "x");
    const runtimeErr = new RuntimeError("X", "x");

    // Config and Agent are siblings
    expect(configErr).not.toBeInstanceOf(AgentError);
    expect(agentErr).not.toBeInstanceOf(ConfigError);

    // Config and Runtime are siblings
    expect(configErr).not.toBeInstanceOf(RuntimeError);
    expect(runtimeErr).not.toBeInstanceOf(ConfigError);

    // But all are VeraError
    expect(configErr).toBeInstanceOf(VeraError);
    expect(agentErr).toBeInstanceOf(VeraError);
    expect(runtimeErr).toBeInstanceOf(VeraError);

    // And all are Error
    expect(configErr).toBeInstanceOf(Error);
    expect(agentErr).toBeInstanceOf(Error);
    expect(runtimeErr).toBeInstanceOf(Error);
  });

  it("deep inheritance chain: DuplicateJobError → AgentError → VeraError → Error", () => {
    const err = new DuplicateJobError("j");
    expect(err).toBeInstanceOf(DuplicateJobError);
    expect(err).toBeInstanceOf(AgentError);
    expect(err).toBeInstanceOf(VeraError);
    expect(err).toBeInstanceOf(Error);
    // NOT orchestrator
    expect(err).not.toBeInstanceOf(OrchestratorError);
  });

  it("deep inheritance chain: AdapterRequestError → AdapterError → VeraError → Error", () => {
    const err = new AdapterRequestError("p", 500);
    expect(err).toBeInstanceOf(AdapterRequestError);
    expect(err).toBeInstanceOf(AdapterError);
    expect(err).toBeInstanceOf(VeraError);
    expect(err).toBeInstanceOf(Error);
  });

  it("deep inheritance chain: FlowStateError → RuntimeError → VeraError → Error", () => {
    const err = new FlowStateError("a", "b");
    expect(err).toBeInstanceOf(FlowStateError);
    expect(err).toBeInstanceOf(RuntimeError);
    expect(err).toBeInstanceOf(VeraError);
    expect(err).toBeInstanceOf(Error);
  });
});
