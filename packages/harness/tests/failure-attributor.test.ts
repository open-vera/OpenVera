import { mkdirSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AdapterError,
  AdapterRequestError,
  AgentError,
  ConfigError,
  DispatchError,
  DuplicateJobError,
  FlowStateError,
  GitError,
  IntentError,
  PlannerError,
  QueueFullError,
  ReplError,
  RemoteRunnerError,
  RuntimeError,
  SessionNotFoundError,
  ToolError,
  ValidationError,
} from "@open-vera/core/errors";
import type { TaskFlow } from "@open-vera/core/types";
import {
  FailureAttributor,
  type FailureAttribution,
  type FailedStep,
} from "../src/runtime/failure-attributor.js";
import type { ArtifactStore, FlowHandle } from "../src/runtime/internal.js";

// ── Test helpers ──────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  const dir = join(
    tmpdir(),
    `failure-attributor-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeFlow(overrides: Partial<TaskFlow> = {}): TaskFlow {
  return {
    flowId: overrides.flowId ?? "test-flow",
    goal: overrides.goal ?? "Test goal",
    state: overrides.state ?? "failed",
    plan: overrides.plan ?? {
      planId: "plan-1",
      goal: "Test goal",
      assumptions: [],
      steps: [
        { id: "s1", type: "tool", action: "run build", status: "done" },
        { id: "s2", type: "tool", action: "run tests", status: "failed" },
        { id: "s3", type: "analyze", action: "verify results", status: "pending" },
      ],
      risk: "low",
    },
    activeStepId: overrides.activeStepId ?? "s2",
    loopCount: overrides.loopCount ?? 1,
    maxLoops: overrides.maxLoops ?? 3,
    budget: overrides.budget ?? { tokensUsed: 1000 },
    scope: overrides.scope ?? {},
    assignedAgents: overrides.assignedAgents ?? [],
    artifacts: overrides.artifacts ?? [],
  };
}

function makeStore(rootDir: string): ArtifactStore {
  const flowDir = join(rootDir, "test-flow");
  mkdirSync(join(flowDir, "artifacts"), { recursive: true });
  return { rootDir, flowDir };
}

function makeHandle(rootDir: string, flowOverrides?: Partial<TaskFlow>): FlowHandle {
  return {
    flow: makeFlow(flowOverrides),
    store: makeStore(rootDir),
  };
}

function readTimeline(store: ArtifactStore): Record<string, unknown>[] {
  const path = join(store.flowDir, "timeline.ndjson");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("FailureAttributor", () => {
  let tmpDir: string;
  let attributor: FailureAttributor;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    attributor = new FailureAttributor();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── F1: Categorization ─────────────────────────────────────────────────────

  describe("categorizeError (synchronous diagnostics)", () => {
    it("categorizes AdapterError as model", () => {
      const result = attributor.categorizeError(
        new AdapterError("RATE_LIMIT", "Rate limit exceeded")
      );
      expect(result.category).toBe("model");
      expect(result.errorCode).toBe("RATE_LIMIT");
      expect(result.rootCause).toContain("LLM adapter error");
      expect(result.recoverable).toBe(true);
    });

    it("categorizes AdapterRequestError as model", () => {
      const result = attributor.categorizeError(
        new AdapterRequestError("anthropic", 429, "Too many requests")
      );
      expect(result.category).toBe("model");
      expect(result.errorCode).toBe("ADAPTER_REQUEST_ERROR");
      expect(result.rootCause).toContain("429");
    });

    it("categorizes ToolError as tool", () => {
      const result = attributor.categorizeError(
        new ToolError("TOOL_TIMEOUT", "Bash command timed out")
      );
      expect(result.category).toBe("tool");
      expect(result.errorCode).toBe("TOOL_TIMEOUT");
      expect(result.rootCause).toContain("Tool execution failed");
    });

    it("categorizes AgentError as tool", () => {
      const result = attributor.categorizeError(
        new AgentError("AGENT_CRASH", "Agent process crashed")
      );
      expect(result.category).toBe("tool");
      expect(result.rootCause).toContain("Agent execution failed");
    });

    it("categorizes RemoteRunnerError as tool", () => {
      const result = attributor.categorizeError(
        new RemoteRunnerError("docker", "container OOM")
      );
      expect(result.category).toBe("tool");
      expect(result.rootCause).toContain("container OOM");
    });

    it("categorizes DuplicateJobError as tool", () => {
      const result = attributor.categorizeError(new DuplicateJobError("job-42"));
      expect(result.category).toBe("tool");
      expect(result.rootCause).toContain("job-42");
    });

    it("categorizes QueueFullError as tool", () => {
      const result = attributor.categorizeError(new QueueFullError(10));
      expect(result.category).toBe("tool");
      expect(result.rootCause).toContain("Queue is full");
    });

    it("categorizes GitError as tool", () => {
      const result = attributor.categorizeError(
        new GitError("merge conflict in src/main.ts")
      );
      expect(result.category).toBe("tool");
      expect(result.rootCause).toContain("Git operation failed");
    });

    it("categorizes ReplError as tool", () => {
      const result = attributor.categorizeError(
        new ReplError("Terminal not available")
      );
      expect(result.category).toBe("tool");
      expect(result.rootCause).toContain("REPL error");
    });

    it("categorizes FlowStateError as plan_deviation", () => {
      const result = attributor.categorizeError(
        new FlowStateError("completed", "executing")
      );
      expect(result.category).toBe("plan_deviation");
      expect(result.rootCause).toContain("Illegal flow state transition");
      expect(result.recoverable).toBe(false);
    });

    it("categorizes DispatchError as plan_deviation", () => {
      const result = attributor.categorizeError(
        new DispatchError("No dispatchable step found")
      );
      expect(result.category).toBe("plan_deviation");
      expect(result.rootCause).toContain("Dispatch error");
    });

    it("categorizes RuntimeError as plan_deviation", () => {
      const result = attributor.categorizeError(
        new RuntimeError("LOOP_EXCEEDED", "Max loop count exceeded")
      );
      expect(result.category).toBe("plan_deviation");
      expect(result.rootCause).toContain("Runtime error");
    });

    it("categorizes PlannerError as plan_deviation", () => {
      const result = attributor.categorizeError(
        new PlannerError("Could not generate plan from goal")
      );
      expect(result.category).toBe("plan_deviation");
      expect(result.rootCause).toContain("Planner error");
      expect(result.recoverable).toBe(true);
    });

    it("categorizes ConfigError as context", () => {
      const result = attributor.categorizeError(
        new ConfigError("Missing API key")
      );
      expect(result.category).toBe("context");
      expect(result.rootCause).toContain("Configuration error");
    });

    it("categorizes SessionNotFoundError as context", () => {
      const result = attributor.categorizeError(
        new SessionNotFoundError("sess-abc")
      );
      expect(result.category).toBe("context");
      expect(result.rootCause).toContain("Session error");
    });

    it("categorizes ValidationError as context", () => {
      const result = attributor.categorizeError(
        new ValidationError("Invalid plan format")
      );
      expect(result.category).toBe("context");
      expect(result.rootCause).toContain("Validation error");
    });

    it("categorizes IntentError as context", () => {
      const result = attributor.categorizeError(
        new IntentError("Could not determine intent")
      );
      expect(result.category).toBe("context");
      expect(result.rootCause).toContain("Intent resolution failed");
    });

    it("categorizes permission-related errors by message content", () => {
      const result = attributor.categorizeError(
        new Error("Access denied: insufficient permissions for resource")
      );
      expect(result.category).toBe("permission");
      expect(result.rootCause).toContain("Permission denied");
    });

    it("categorizes 403 errors as permission", () => {
      const result = attributor.categorizeError(
        new Error("Request failed with status 403 Forbidden")
      );
      expect(result.category).toBe("permission");
      expect(result.recoverable).toBe(false);
    });

    it("categorizes 401 errors as permission", () => {
      const result = attributor.categorizeError(
        new Error("401 Unauthorized: invalid token")
      );
      expect(result.category).toBe("permission");
    });

    it("categorizes 'forbidden' keyword as permission", () => {
      const result = attributor.categorizeError(
        new Error("This action is forbidden for your role")
      );
      expect(result.category).toBe("permission");
    });

    it("categorizes unknown errors as context", () => {
      const result = attributor.categorizeError("some random string error");
      expect(result.category).toBe("context");
      expect(result.rootCause).toContain("Unknown error");
      expect(result.errorCode).toBe("UNKNOWN_ERROR");
      expect(result.recoverable).toBe(false);
    });

    it("categorizes non-Error objects as context", () => {
      const result = attributor.categorizeError({ code: 500, msg: "bad" });
      expect(result.category).toBe("context");
      expect(result.rootCause).toContain("Unknown error");
    });
  });

  // ── F3: Root cause recording ───────────────────────────────────────────────

  describe("attribute (timeline recording)", () => {
    it("writes failure entry to timeline.ndjson with correct format", async () => {
      const handle = makeHandle(tmpDir);
      const error = new ToolError("TOOL_TIMEOUT", "curl timed out after 30s");

      const attribution = await attributor.attribute(handle, "s2", error);

      expect(attribution.stepId).toBe("s2");
      expect(attribution.category).toBe("tool");
      expect(attribution.errorCode).toBe("TOOL_TIMEOUT");

      const entries = readTimeline(handle.store);
      expect(entries).toHaveLength(1);

      const entry = entries[0] as Record<string, unknown>;
      expect(entry.type).toBe("failure");
      expect(entry.stepId).toBe("s2");
      expect(entry.category).toBe("tool");
      expect(entry.rootCause).toContain("Tool execution failed");
      expect(entry.error).toBe("curl timed out after 30s");
      expect(typeof entry.ts).toBe("string");
      expect(entry.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it("appends multiple failure entries to the same timeline", async () => {
      const handle = makeHandle(tmpDir);

      await attributor.attribute(
        handle,
        "s1",
        new AdapterError("TIMEOUT", "LLM timeout")
      );
      await attributor.attribute(
        handle,
        "s2",
        new ToolError("EXEC_FAIL", "command failed")
      );

      const entries = readTimeline(handle.store);
      expect(entries).toHaveLength(2);
      expect(entries[0].stepId).toBe("s1");
      expect(entries[0].category).toBe("model");
      expect(entries[1].stepId).toBe("s2");
      expect(entries[1].category).toBe("tool");
    });

    it("records non-VeraError with UNKNOWN_ERROR code", async () => {
      const handle = makeHandle(tmpDir);
      const attribution = await attributor.attribute(
        handle,
        "s1",
        new Error("something broke")
      );

      expect(attribution.errorCode).toBe("UNKNOWN_ERROR");
    });

    it("records string errors correctly", async () => {
      const handle = makeHandle(tmpDir);
      const attribution = await attributor.attribute(
        handle,
        "s1",
        "raw string error"
      );

      expect(attribution.category).toBe("context");
      expect(attribution.rootCause).toContain("Unknown error");
      expect(attribution.errorCode).toBe("UNKNOWN_ERROR");
    });

    it("creates timeline file if it does not exist", async () => {
      const handle = makeHandle(tmpDir);
      const timelinePath = join(handle.store.flowDir, "timeline.ndjson");

      // Remove the file if it somehow exists
      rmSync(timelinePath, { force: true });

      await attributor.attribute(
        handle,
        "s1",
        new ConfigError("Missing key")
      );

      expect(existsSync(timelinePath)).toBe(true);
      const entries = readTimeline(handle.store);
      expect(entries).toHaveLength(1);
    });
  });

  // ── F4: Failed step extraction ─────────────────────────────────────────────

  describe("extractFailedSteps", () => {
    it("returns only steps with status failed", () => {
      const handle = makeHandle(tmpDir);
      const failed = attributor.extractFailedSteps(handle);

      expect(failed).toHaveLength(1);
      expect(failed[0].stepId).toBe("s2");
      expect(failed[0].action).toBe("run tests");
      expect(failed[0].type).toBe("tool");
    });

    it("preserves dependsOn for failed steps", () => {
      const handle = makeHandle(tmpDir, {
        plan: {
          planId: "p1",
          goal: "g",
          assumptions: [],
          steps: [
            {
              id: "s1",
              type: "tool",
              action: "a",
              status: "done",
            },
            {
              id: "s2",
              type: "analyze",
              action: "b",
              status: "failed",
              dependsOn: ["s1"],
            },
          ],
          risk: "low",
        },
      });

      const failed = attributor.extractFailedSteps(handle);
      expect(failed).toHaveLength(1);
      expect(failed[0].dependsOn).toEqual(["s1"]);
    });

    it("returns empty array when no steps are failed", () => {
      const handle = makeHandle(tmpDir, {
        plan: {
          planId: "p1",
          goal: "g",
          assumptions: [],
          steps: [
            { id: "s1", type: "tool", action: "a", status: "done" },
            { id: "s2", type: "tool", action: "b", status: "pending" },
          ],
          risk: "low",
        },
      });

      const failed = attributor.extractFailedSteps(handle);
      expect(failed).toHaveLength(0);
    });

    it("returns empty array when flow has no plan", () => {
      const flow: TaskFlow = {
        flowId: "test-flow",
        goal: "Test goal",
        state: "failed",
        activeStepId: undefined,
        loopCount: 1,
        maxLoops: 3,
        budget: { tokensUsed: 0 },
        scope: {},
        assignedAgents: [],
        artifacts: [],
      };
      const handle: FlowHandle = {
        flow,
        store: makeStore(tmpDir),
      };
      const failed = attributor.extractFailedSteps(handle);
      expect(failed).toHaveLength(0);
    });

    it("returns multiple failed steps", () => {
      const handle = makeHandle(tmpDir, {
        plan: {
          planId: "p1",
          goal: "g",
          assumptions: [],
          steps: [
            { id: "s1", type: "tool", action: "a", status: "failed" },
            { id: "s2", type: "tool", action: "b", status: "failed" },
            { id: "s3", type: "tool", action: "c", status: "done" },
          ],
          risk: "low",
        },
      });

      const failed = attributor.extractFailedSteps(handle);
      expect(failed).toHaveLength(2);
      expect(failed.map((f) => f.stepId)).toEqual(["s1", "s2"]);
    });

    it("defaults dependsOn to empty array when undefined", () => {
      const handle = makeHandle(tmpDir, {
        plan: {
          planId: "p1",
          goal: "g",
          assumptions: [],
          steps: [
            { id: "s1", type: "tool", action: "a", status: "failed" },
          ],
          risk: "low",
        },
      });

      const failed = attributor.extractFailedSteps(handle);
      expect(failed[0].dependsOn).toEqual([]);
    });
  });

  // ── Edge cases ─────────────────────────────────────────────────────────────

  describe("edge cases", () => {
    it("handles VeraError subclass inheritance correctly", () => {
      // AdapterRequestError extends AdapterError extends VeraError
      // Should match the AdapterError rule (first match wins)
      const result = attributor.categorizeError(
        new AdapterRequestError("openai", 500, "Internal server error")
      );
      expect(result.category).toBe("model");
      expect(result.errorCode).toBe("ADAPTER_REQUEST_ERROR");
    });

    it("categorizeError returns empty stepId for standalone use", () => {
      const result = attributor.categorizeError(new ToolError("X", "msg"));
      expect(result.stepId).toBe("");
    });

    it("handles flow in non-failed state for extractFailedSteps", () => {
      const handle = makeHandle(tmpDir, {
        state: "executing",
        plan: {
          planId: "p1",
          goal: "g",
          assumptions: [],
          steps: [
            { id: "s1", type: "tool", action: "a", status: "failed" },
          ],
          risk: "low",
        },
      });

      const failed = attributor.extractFailedSteps(handle);
      expect(failed).toHaveLength(1);
    });

    it("recoverable flag is false for plan_deviation from runtime errors", () => {
      const result = attributor.categorizeError(
        new RuntimeError("EXHAUSTED", "Budget exhausted")
      );
      expect(result.recoverable).toBe(false);
    });

    it("recoverable flag is true for planner errors", () => {
      const result = attributor.categorizeError(
        new PlannerError("Ambiguous goal")
      );
      expect(result.recoverable).toBe(true);
    });
  });
});
