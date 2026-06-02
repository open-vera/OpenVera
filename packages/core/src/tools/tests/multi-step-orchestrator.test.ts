// Tests for multi-step-orchestrator

import { describe, it, expect, vi } from "vitest";
import {
  MultiStepOrchestrator,
  StepPatterns,
  interpolateVars,
  evaluateCondition,
  type StepDefinition,
  type ToolResolver,
  type StepResult,
  type StepCondition,
  type ConditionOp,
} from "../multi-step-orchestrator.js";
import type { ToolDef, ToolResult, ToolContext } from "../types.js";

// ── Helpers ────────────────────────────────────────────────────────────────────

const mockCtx: ToolContext = {
  cwd: "/tmp",
  sessionId: "test-session",
};

function mockTool(name: string, result: ToolResult): ToolDef {
  return {
    name,
    description: `Mock ${name}`,
    parameters: { type: "object", properties: {} },
    execute: vi.fn().mockResolvedValue(result),
  };
}

function okResult(content: string): ToolResult {
  return { ok: true, content };
}

function failResult(message: string): ToolResult {
  return {
    ok: false,
    content: message,
    error: { code: "EXEC_ERROR", message, retryable: false },
  };
}

// ── interpolateVars ────────────────────────────────────────────────────────────

describe("interpolateVars", () => {
  it("replaces ${var} placeholders in strings", () => {
    const result = interpolateVars(
      { url: "${args.url}", selector: "#login" },
      { "args.url": "https://example.com" },
    );
    expect(result).toEqual({
      url: "https://example.com",
      selector: "#login",
    });
  });

  it("handles nested objects", () => {
    const result = interpolateVars(
      { config: { path: "${args.path}/file.txt" } },
      { "args.path": "/home" },
    );
    expect(result).toEqual({ config: { path: "/home/file.txt" } });
  });

  it("handles arrays with string interpolation", () => {
    const result = interpolateVars(
      { items: ["${args.a}", "static", "${args.b}"] },
      { "args.a": "hello", "args.b": "world" },
    );
    expect(result).toEqual({ items: ["hello", "static", "world"] });
  });

  it("leaves unresolved vars as-is", () => {
    const result = interpolateVars(
      { url: "${missing.var}" },
      {},
    );
    expect(result).toEqual({ url: "${missing.var}" });
  });

  it("passes through non-string values unchanged", () => {
    const result = interpolateVars(
      { count: 42, flag: true, data: null },
      {},
    );
    expect(result).toEqual({ count: 42, flag: true, data: null });
  });

  it("handles arrays with mixed types (string, number, null)", () => {
    const result = interpolateVars(
      { items: ["${args.a}", 42, null, "${args.b}"] },
      { "args.a": "hello", "args.b": "world" },
    );
    expect(result).toEqual({ items: ["hello", 42, null, "world"] });
  });

  it("replaces multiple ${var} placeholders in a single string", () => {
    const result = interpolateVars(
      { url: "${args.host}/api/${args.version}/data" },
      { "args.host": "https://example.com", "args.version": "v2" },
    );
    expect(result).toEqual({ url: "https://example.com/api/v2/data" });
  });

  it("passes through objects nested inside arrays as-is", () => {
    // objects inside arrays are not recursively interpolated
    const result = interpolateVars(
      { items: [{ name: "${args.name}" }] },
      { "args.name": "test" },
    );
    expect(result).toEqual({ items: [{ name: "${args.name}" }] });
  });

  it("partially resolves vars when some are present and some missing", () => {
    const result = interpolateVars(
      { text: "${present} and ${missing}" },
      { present: "hello" },
    );
    expect(result).toEqual({ text: "hello and ${missing}" });
  });
});

// ── evaluateCondition ──────────────────────────────────────────────────────────

describe("evaluateCondition", () => {
  const successStep: StepResult = {
    stepId: "s1",
    ok: true,
    content: "login successful",
    durationMs: 100,
    retries: 0,
    skipped: false,
  };

  const failStep: StepResult = {
    stepId: "s2",
    ok: false,
    content: "error occurred",
    durationMs: 50,
    retries: 0,
    skipped: false,
    error: "timeout",
  };

  const results = new Map<string, StepResult>();
  results.set("s1", successStep);
  results.set("s2", failStep);

  it("evaluates 'success' condition", () => {
    expect(evaluateCondition({ op: "success" }, results)).toBe(false); // last = s2 (failed)
    expect(evaluateCondition({ op: "success", ref: "s1" }, results)).toBe(true);
  });

  it("evaluates 'failure' condition", () => {
    expect(evaluateCondition({ op: "failure" }, results)).toBe(true); // last = s2 (failed)
    expect(evaluateCondition({ op: "failure", ref: "s1" }, results)).toBe(false);
  });

  it("evaluates 'contains' condition", () => {
    expect(evaluateCondition({ op: "contains", value: "successful" }, results)).toBe(false);
    expect(evaluateCondition({ op: "contains", value: "successful", ref: "s1" }, results)).toBe(true);
    expect(evaluateCondition({ op: "contains", value: "error", ref: "s2" }, results)).toBe(true);
  });

  it("evaluates 'equals' condition", () => {
    expect(evaluateCondition({ op: "equals", value: "login successful", ref: "s1" }, results)).toBe(true);
    expect(evaluateCondition({ op: "equals", value: "other", ref: "s1" }, results)).toBe(false);
  });

  it("evaluates 'matches' condition with regex", () => {
    expect(evaluateCondition({ op: "matches", value: "login\\s+success", ref: "s1" }, results)).toBe(true);
    expect(evaluateCondition({ op: "matches", value: "^error", ref: "s2" }, results)).toBe(true);
  });

  it("returns false for missing ref", () => {
    expect(evaluateCondition({ op: "success", ref: "nonexistent" }, results)).toBe(false);
  });

  it("returns false for 'contains' when value is undefined", () => {
    expect(evaluateCondition({ op: "contains" } as StepCondition, results)).toBe(false);
  });

  it("returns false for 'equals' when value is undefined", () => {
    expect(evaluateCondition({ op: "equals" } as StepCondition, results)).toBe(false);
  });

  it("returns false for 'matches' when value is undefined", () => {
    expect(evaluateCondition({ op: "matches" } as StepCondition, results)).toBe(false);
  });

  it("returns false for unknown operator", () => {
    expect(evaluateCondition({ op: "unknown" as ConditionOp }, results)).toBe(false);
  });

  it("returns false when results map is empty and no ref is given", () => {
    const emptyResults = new Map<string, StepResult>();
    expect(evaluateCondition({ op: "success" }, emptyResults)).toBe(false);
  });
});

// ── MultiStepOrchestrator ──────────────────────────────────────────────────────

describe("MultiStepOrchestrator", () => {
  it("executes steps sequentially and returns combined result", async () => {
    const tools = new Map<string, ToolDef>();
    tools.set("browser", mockTool("browser", okResult("navigated")));
    tools.set("bash", mockTool("bash", okResult("done")));

    const resolver: ToolResolver = (name) => tools.get(name);
    const orchestrator = new MultiStepOrchestrator();

    const steps: StepDefinition[] = [
      { id: "nav", tool: "browser", args: { action: "navigate", url: "https://example.com" } },
      { id: "exec", tool: "bash", args: { command: "echo hello" } },
    ];

    const result = await orchestrator.execute(steps, resolver, mockCtx);

    expect(result.ok).toBe(true);
    expect(result.steps).toHaveLength(2);
    expect(result.steps[0].stepId).toBe("nav");
    expect(result.steps[0].ok).toBe(true);
    expect(result.steps[1].stepId).toBe("exec");
    expect(result.steps[1].ok).toBe(true);
    expect(result.content).toBe("done"); // last successful step
  });

  it("stops on error when stopOnError=true (default)", async () => {
    const tools = new Map<string, ToolDef>();
    tools.set("browser", mockTool("browser", failResult("navigation failed")));
    tools.set("bash", mockTool("bash", okResult("done")));

    const resolver: ToolResolver = (name) => tools.get(name);
    const orchestrator = new MultiStepOrchestrator();

    const steps: StepDefinition[] = [
      { id: "nav", tool: "browser", args: { url: "https://bad.com" } },
      { id: "exec", tool: "bash", args: { command: "echo hello" } },
    ];

    const result = await orchestrator.execute(steps, resolver, mockCtx);

    expect(result.ok).toBe(false);
    expect(result.steps).toHaveLength(1); // stopped after first step
    expect(result.error).toContain("navigation failed");
  });

  it("continues on error with onError='skip'", async () => {
    const tools = new Map<string, ToolDef>();
    tools.set("browser", mockTool("browser", failResult("nav failed")));
    tools.set("bash", mockTool("bash", okResult("executed")));

    const resolver: ToolResolver = (name) => tools.get(name);
    const orchestrator = new MultiStepOrchestrator();

    const steps: StepDefinition[] = [
      { id: "nav", tool: "browser", args: {}, onError: "skip" },
      { id: "exec", tool: "bash", args: { command: "echo hello" } },
    ];

    const result = await orchestrator.execute(steps, resolver, mockCtx);

    expect(result.ok).toBe(true); // overall ok because failed step was skipped
    expect(result.steps).toHaveLength(2);
    expect(result.steps[0].ok).toBe(false);
    expect(result.steps[1].ok).toBe(true);
  });

  it("retries failed steps", async () => {
    let callCount = 0;
    const flakyTool: ToolDef = {
      name: "flaky",
      description: "flaky tool",
      parameters: { type: "object", properties: {} },
      execute: vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount < 3) return failResult("temporary error");
        return okResult("success on retry");
      }),
    };

    const tools = new Map<string, ToolDef>();
    tools.set("flaky", flakyTool);

    const resolver: ToolResolver = (name) => tools.get(name);
    const orchestrator = new MultiStepOrchestrator();

    const steps: StepDefinition[] = [
      { id: "retry", tool: "flaky", args: {}, maxRetries: 3 },
    ];

    const result = await orchestrator.execute(steps, resolver, mockCtx);

    expect(result.ok).toBe(true);
    expect(result.steps[0].retries).toBe(2); // succeeded on 3rd attempt
    expect(result.steps[0].content).toBe("success on retry");
  });

  it("skips steps when condition is not met", async () => {
    const tools = new Map<string, ToolDef>();
    tools.set("step1", mockTool("step1", okResult("step1 done")));
    tools.set("step2", mockTool("step2", okResult("step2 done")));

    const resolver: ToolResolver = (name) => tools.get(name);
    const orchestrator = new MultiStepOrchestrator();

    const steps: StepDefinition[] = [
      { id: "s1", tool: "step1", args: {} },
      {
        id: "s2",
        tool: "step2",
        args: {},
        condition: { ref: "s1", op: "contains", value: "nonexistent" },
      },
    ];

    const result = await orchestrator.execute(steps, resolver, mockCtx);

    expect(result.ok).toBe(true);
    expect(result.steps[1].skipped).toBe(true);
    // step2 tool should not have been called
    expect(tools.get("step2")!.execute).not.toHaveBeenCalled();
  });

  it("passes variables between steps", async () => {
    const step1Tool = mockTool("step1", okResult("https://result.com"));
    const step2Tool: ToolDef = {
      name: "step2",
      description: "step2",
      parameters: { type: "object", properties: {} },
      execute: vi.fn().mockResolvedValue(okResult("navigated")),
    };

    const tools = new Map<string, ToolDef>();
    tools.set("step1", step1Tool);
    tools.set("step2", step2Tool);

    const resolver: ToolResolver = (name) => tools.get(name);
    const orchestrator = new MultiStepOrchestrator();

    const steps: StepDefinition[] = [
      { id: "extract", tool: "step1", args: {} },
      { id: "navigate", tool: "step2", args: { url: "${extract.output}" } },
    ];

    const result = await orchestrator.execute(steps, resolver, mockCtx);

    expect(result.ok).toBe(true);
    // Verify step2 received interpolated URL
    expect(step2Tool.execute).toHaveBeenCalledWith(
      expect.objectContaining({ url: "https://result.com" }),
      expect.anything(),
    );
  });

  it("handles missing tool gracefully", async () => {
    const resolver: ToolResolver = () => undefined;
    const orchestrator = new MultiStepOrchestrator();

    const steps: StepDefinition[] = [
      { id: "bad", tool: "nonexistent", args: {} },
    ];

    const result = await orchestrator.execute(steps, resolver, mockCtx);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("tool \"nonexistent\" not found");
  });

  it("respects global timeout", async () => {
    const slowTool: ToolDef = {
      name: "slow",
      description: "slow tool",
      parameters: { type: "object", properties: {} },
      execute: vi.fn().mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve(okResult("done")), 500)),
      ),
    };

    const tools = new Map<string, ToolDef>();
    tools.set("slow", slowTool);

    const resolver: ToolResolver = (name) => tools.get(name);
    const orchestrator = new MultiStepOrchestrator({ globalTimeoutMs: 100 });

    const steps: StepDefinition[] = [
      { id: "s1", tool: "slow", args: {} },
      { id: "s2", tool: "slow", args: {} },
    ];

    const result = await orchestrator.execute(steps, resolver, mockCtx);

    // Should timeout after first step or during it
    expect(result.ok).toBe(false);
    expect(result.error).toContain("timed out");
  });

  it("handles empty steps array", async () => {
    const resolver: ToolResolver = () => undefined;
    const orchestrator = new MultiStepOrchestrator();

    const result = await orchestrator.execute([], resolver, mockCtx);

    expect(result.ok).toBe(true);
    expect(result.steps).toHaveLength(0);
    expect(result.content).toBe("");
  });

  it("builds variable context from inputArgs", async () => {
    const tools = new Map<string, ToolDef>();
    tools.set("echo", mockTool("echo", okResult("hello world")));

    const resolver: ToolResolver = (name) => tools.get(name);
    const orchestrator = new MultiStepOrchestrator();

    const steps: StepDefinition[] = [
      { id: "s1", tool: "echo", args: { message: "${args.greeting} ${args.target}" } },
    ];

    const result = await orchestrator.execute(steps, resolver, mockCtx, {
      greeting: "Hello",
      target: "World",
    });

    expect(result.ok).toBe(true);
    const echoTool = tools.get("echo")!;
    expect(echoTool.execute).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Hello World" }),
      expect.anything(),
    );
  });

  it("ignores non-string inputArgs for variable context", async () => {
    const tools = new Map<string, ToolDef>();
    tools.set("echo", mockTool("echo", okResult("done")));

    const resolver: ToolResolver = (name) => tools.get(name);
    const orchestrator = new MultiStepOrchestrator();

    const steps: StepDefinition[] = [
      { id: "s1", tool: "echo", args: { count: "${args.count}" } },
    ];

    const result = await orchestrator.execute(steps, resolver, mockCtx, {
      count: 42, // number, not string
    });

    expect(result.ok).toBe(true);
    const echoTool = tools.get("echo")!;
    // Non-string inputArgs are not added to varContext; placeholder stays unresolved
    expect(echoTool.execute).toHaveBeenCalledWith(
      expect.objectContaining({ count: "${args.count}" }),
      expect.anything(),
    );
  });

  it("handles tool.execute throwing an exception", async () => {
    const throwingTool: ToolDef = {
      name: "thrower",
      description: "throws",
      parameters: { type: "object", properties: {} },
      execute: vi.fn().mockRejectedValue(new Error("unexpected crash")),
    };

    const tools = new Map<string, ToolDef>();
    tools.set("thrower", throwingTool);

    const resolver: ToolResolver = (name) => tools.get(name);
    const orchestrator = new MultiStepOrchestrator();

    const steps: StepDefinition[] = [
      { id: "crash", tool: "thrower", args: {} },
    ];

    const result = await orchestrator.execute(steps, resolver, mockCtx);

    expect(result.ok).toBe(false);
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0].ok).toBe(false);
    expect(result.steps[0].error).toContain("unexpected crash");
    expect(result.error).toContain("unexpected crash");
  });

  it("retries when tool.execute throws and eventually succeeds", async () => {
    let throwCount = 0;
    const flakyThrower: ToolDef = {
      name: "flaky",
      description: "flaky thrower",
      parameters: { type: "object", properties: {} },
      execute: vi.fn().mockImplementation(async () => {
        throwCount++;
        if (throwCount < 3) throw new Error("temporary crash");
        return okResult("recovered");
      }),
    };

    const tools = new Map<string, ToolDef>();
    tools.set("flaky", flakyThrower);

    const resolver: ToolResolver = (name) => tools.get(name);
    const orchestrator = new MultiStepOrchestrator();

    const steps: StepDefinition[] = [
      { id: "recovery", tool: "flaky", args: {}, maxRetries: 3 },
    ];

    const result = await orchestrator.execute(steps, resolver, mockCtx);

    expect(result.ok).toBe(true);
    expect(result.steps[0].retries).toBe(2);
    expect(result.steps[0].content).toBe("recovered");
  });

  it("onError 'skip' with exhausted maxRetries marks step as skipped", async () => {
    const alwaysFail: ToolDef = {
      name: "failer",
      description: "always fails",
      parameters: { type: "object", properties: {} },
      execute: vi.fn().mockResolvedValue(failResult("permanent error")),
    };

    const tools = new Map<string, ToolDef>();
    tools.set("failer", alwaysFail);
    tools.set("next", mockTool("next", okResult("next step done")));

    const resolver: ToolResolver = (name) => tools.get(name);
    const orchestrator = new MultiStepOrchestrator();

    const steps: StepDefinition[] = [
      { id: "f1", tool: "failer", args: {}, maxRetries: 2, onError: "skip" },
      { id: "s2", tool: "next", args: {} },
    ];

    const result = await orchestrator.execute(steps, resolver, mockCtx);

    expect(result.ok).toBe(true); // overall ok because skipped
    expect(result.steps).toHaveLength(2);
    expect(result.steps[0].ok).toBe(false);
    expect(result.steps[0].skipped).toBe(true); // marked as skipped
    expect(result.steps[0].retries).toBe(2); // all 3 attempts exhausted
    expect(result.steps[1].ok).toBe(true);
    expect(result.content).toBe("next step done");
  });

  it("onError 'retry' continues execution after exhausted retries but overall fails", async () => {
    const alwaysFail: ToolDef = {
      name: "failer",
      description: "always fails",
      parameters: { type: "object", properties: {} },
      execute: vi.fn().mockResolvedValue(failResult("exhausted")),
    };

    const tools = new Map<string, ToolDef>();
    tools.set("failer", alwaysFail);
    tools.set("next", mockTool("next", okResult("continues")));

    const resolver: ToolResolver = (name) => tools.get(name);
    const orchestrator = new MultiStepOrchestrator();

    const steps: StepDefinition[] = [
      { id: "f1", tool: "failer", args: {}, maxRetries: 1, onError: "retry" },
      { id: "s2", tool: "next", args: {} },
    ];

    const result = await orchestrator.execute(steps, resolver, mockCtx);

    // Execution continues past the failed step
    expect(result.steps).toHaveLength(2);
    expect(result.steps[0].ok).toBe(false);
    expect(result.steps[0].skipped).toBe(false);
    expect(result.steps[1].ok).toBe(true);
    // But overall fails because failed step is not skipped
    expect(result.ok).toBe(false);
    expect(result.content).toBe("continues");
  });

  it("stopOnError=false continues past a missing tool", async () => {
    const tools = new Map<string, ToolDef>();
    tools.set("echo", mockTool("echo", okResult("done")));

    const resolver: ToolResolver = (name) => tools.get(name);
    const orchestrator = new MultiStepOrchestrator({ stopOnError: false });

    const steps: StepDefinition[] = [
      { id: "bad", tool: "nonexistent", args: {} },
      { id: "good", tool: "echo", args: {} },
    ];

    const result = await orchestrator.execute(steps, resolver, mockCtx);

    // Should continue past the missing tool
    expect(result.steps).toHaveLength(2);
    expect(result.steps[0].ok).toBe(false);
    expect(result.steps[0].error).toContain("not found");
    expect(result.steps[1].ok).toBe(true);
    expect(result.ok).toBe(false); // one step failed
    expect(result.content).toBe("done");
  });

  it("stores metadata.exitCode in variable context", async () => {
    const exitCodeTool: ToolDef = {
      name: "runner",
      description: "runs something",
      parameters: { type: "object", properties: {} },
      execute: vi.fn().mockResolvedValue({
        ok: true,
        content: "command output",
        metadata: { exitCode: 0 },
      } as ToolResult),
    };

    const checkerTool: ToolDef = {
      name: "checker",
      description: "checks exit code",
      parameters: { type: "object", properties: {} },
      execute: vi.fn().mockResolvedValue(okResult("checked")),
    };

    const tools = new Map<string, ToolDef>();
    tools.set("runner", exitCodeTool);
    tools.set("checker", checkerTool);

    const resolver: ToolResolver = (name) => tools.get(name);
    const orchestrator = new MultiStepOrchestrator();

    const steps: StepDefinition[] = [
      { id: "run", tool: "runner", args: {} },
      { id: "check", tool: "checker", args: { code: "${run.exitCode}" } },
    ];

    const result = await orchestrator.execute(steps, resolver, mockCtx);

    expect(result.ok).toBe(true);
    expect(checkerTool.execute).toHaveBeenCalledWith(
      expect.objectContaining({ code: "0" }),
      expect.anything(),
    );
  });

  it("content comes from last non-skipped successful step", async () => {
    const tools = new Map<string, ToolDef>();
    tools.set("step1", mockTool("step1", okResult("first")));
    tools.set("step2", mockTool("step2", okResult("second")));
    tools.set("step3", mockTool("step3", okResult("third")));

    const resolver: ToolResolver = (name) => tools.get(name);
    const orchestrator = new MultiStepOrchestrator();

    const steps: StepDefinition[] = [
      { id: "s1", tool: "step1", args: {} },
      { id: "s2", tool: "step2", args: {} },
      {
        id: "s3",
        tool: "step3",
        args: {},
        condition: { ref: "s1", op: "contains", value: "nonexistent" },
      },
    ];

    const result = await orchestrator.execute(steps, resolver, mockCtx);

    expect(result.ok).toBe(true);
    // s3 is skipped, so content comes from s2 (last successful non-skipped)
    expect(result.content).toBe("second");
  });

  it("all steps skipped results in empty content", async () => {
    const tools = new Map<string, ToolDef>();
    tools.set("s1", mockTool("s1", okResult("unused")));
    tools.set("s2", mockTool("s2", okResult("unused")));

    const resolver: ToolResolver = (name) => tools.get(name);
    const orchestrator = new MultiStepOrchestrator();

    const steps: StepDefinition[] = [
      {
        id: "skip1",
        tool: "s1",
        args: {},
        condition: { ref: "nonexistent", op: "success" },
      },
      {
        id: "skip2",
        tool: "s2",
        args: {},
        condition: { ref: "skip1", op: "failure" }, // skip1.ok=true, so failure evaluates to false
      },
    ];

    const result = await orchestrator.execute(steps, resolver, mockCtx);

    expect(result.ok).toBe(true); // all skipped = ok
    expect(result.steps).toHaveLength(2);
    expect(result.steps[0].skipped).toBe(true);
    expect(result.steps[1].skipped).toBe(true);
    expect(result.content).toBe("");
  });

  it("tool result metadata without exitCode does not pollute varContext", async () => {
    const toolA: ToolDef = {
      name: "toolA",
      description: "no exit code",
      parameters: { type: "object", properties: {} },
      execute: vi.fn().mockResolvedValue({
        ok: true,
        content: "result A",
        metadata: { someOtherField: "value" },
      } as ToolResult),
    };
    const toolB = mockTool("toolB", okResult("done"));

    const tools = new Map<string, ToolDef>();
    tools.set("toolA", toolA);
    tools.set("toolB", toolB);

    const resolver: ToolResolver = (name) => tools.get(name);
    const orchestrator = new MultiStepOrchestrator();

    const steps: StepDefinition[] = [
      { id: "step_a", tool: "toolA", args: {} },
      { id: "step_b", tool: "toolB", args: { ref: "${step_a.exitCode}" } },
    ];

    const result = await orchestrator.execute(steps, resolver, mockCtx);

    expect(result.ok).toBe(true);
    // exitCode was not stored (undefined), so placeholder stays unresolved
    expect(toolB.execute).toHaveBeenCalledWith(
      expect.objectContaining({ ref: "${step_a.exitCode}" }),
      expect.anything(),
    );
  });

  it("does not double-count retries when tool throws then succeeds", async () => {
    let attempts = 0;
    const tool: ToolDef = {
      name: "erratic",
      description: "throws once then succeeds",
      parameters: { type: "object", properties: {} },
      execute: vi.fn().mockImplementation(async () => {
        attempts++;
        if (attempts === 1) throw new Error("first crash");
        return okResult("ok");
      }),
    };

    const tools = new Map<string, ToolDef>();
    tools.set("erratic", tool);

    const resolver: ToolResolver = (name) => tools.get(name);
    const orchestrator = new MultiStepOrchestrator();

    const steps: StepDefinition[] = [
      { id: "s1", tool: "erratic", args: {}, maxRetries: 2 },
    ];

    const result = await orchestrator.execute(steps, resolver, mockCtx);

    expect(result.ok).toBe(true);
    expect(result.steps[0].retries).toBe(1); // 1 retry (throw), 2nd attempt succeeded
  });

  it("handles tool throwing a non-Error value (String(err) path)", async () => {
    const stringThrower: ToolDef = {
      name: "stringThrower",
      description: "throws a string",
      parameters: { type: "object", properties: {} },
      execute: vi.fn().mockRejectedValue("raw string error"),
    };

    const tools = new Map<string, ToolDef>();
    tools.set("stringThrower", stringThrower);

    const resolver: ToolResolver = (name) => tools.get(name);
    const orchestrator = new MultiStepOrchestrator();

    const steps: StepDefinition[] = [
      { id: "crash", tool: "stringThrower", args: {} },
    ];

    const result = await orchestrator.execute(steps, resolver, mockCtx);

    expect(result.ok).toBe(false);
    expect(result.steps[0].error).toBe("raw string error");
  });

  it("handles negative maxRetries (loop body never runs)", async () => {
    const tool = mockTool("test", okResult("should not be called"));

    const tools = new Map<string, ToolDef>();
    tools.set("test", tool);

    const resolver: ToolResolver = (name) => tools.get(name);
    const orchestrator = new MultiStepOrchestrator();

    const steps: StepDefinition[] = [
      { id: "s1", tool: "test", args: {}, maxRetries: -1 },
    ];

    const result = await orchestrator.execute(steps, resolver, mockCtx);

    // Loop body never executed, stepResult stays null, continue skips
    // No step results at all
    expect(result.ok).toBe(true);
    expect(result.steps).toHaveLength(0);
    expect(result.content).toBe("");
  });

  it("handles failed result without error object (uses content as error fallback)", async () => {
    const noErrorTool: ToolDef = {
      name: "noError",
      description: "fails without error object",
      parameters: { type: "object", properties: {} },
      execute: vi.fn().mockResolvedValue({
        ok: false,
        content: "failure content",
        // no error field
      } as ToolResult),
    };

    const tools = new Map<string, ToolDef>();
    tools.set("noError", noErrorTool);

    const resolver: ToolResolver = (name) => tools.get(name);
    const orchestrator = new MultiStepOrchestrator();

    const steps: StepDefinition[] = [
      { id: "f1", tool: "noError", args: {} },
    ];

    const result = await orchestrator.execute(steps, resolver, mockCtx);

    expect(result.ok).toBe(false);
    expect(result.steps[0].error).toBe("failure content"); // falls back to content
  });

  it("passes step timeoutMs alongside context signal (exercises empty guard)", async () => {
    const tool = mockTool("echo", okResult("done"));

    const tools = new Map<string, ToolDef>();
    tools.set("echo", tool);

    const resolver: ToolResolver = (name) => tools.get(name);
    const orchestrator = new MultiStepOrchestrator();

    const controller = new AbortController();
    const steps: StepDefinition[] = [
      { id: "s1", tool: "echo", args: {}, timeoutMs: 5000 },
    ];

    const result = await orchestrator.execute(steps, resolver, {
      ...mockCtx,
      signal: controller.signal,
    });

    expect(result.ok).toBe(true);
    expect(result.steps[0].ok).toBe(true);
  });
});

// ── StepPatterns ───────────────────────────────────────────────────────────────

describe("StepPatterns", () => {
  it("browseAndAnalyze returns correct steps", () => {
    const steps = StepPatterns.browseAndAnalyze("https://example.com", "/tmp/shot.png");

    expect(steps).toHaveLength(3);
    expect(steps[0].tool).toBe("browser");
    expect(steps[0].args).toEqual({ action: "navigate", url: "https://example.com" });
    expect(steps[1].tool).toBe("browser");
    expect(steps[1].args).toEqual({ action: "screenshot", path: "/tmp/shot.png" });
    expect(steps[2].tool).toBe("visual_analyze");
    expect(steps[2].condition?.op).toBe("success");
  });

  it("login returns correct steps", () => {
    const steps = StepPatterns.login("https://example.com", {
      username: "user@test.com",
      password: "secret",
    });

    expect(steps).toHaveLength(4);
    expect(steps[0].id).toBe("navigate");
    expect(steps[1].id).toBe("fill_username");
    expect(steps[2].id).toBe("fill_password");
    expect(steps[3].id).toBe("submit");

    // Each step (except first) depends on previous success
    expect(steps[1].condition).toEqual({ ref: "navigate", op: "success" });
    expect(steps[2].condition).toEqual({ ref: "fill_username", op: "success" });
    expect(steps[3].condition).toEqual({ ref: "fill_password", op: "success" });
  });

  it("login returns correct steps with custom selectors", () => {
    const steps = StepPatterns.login("https://example.com", {
      username: "user@test.com",
      password: "secret",
      userSelector: "#custom-user",
      passSelector: "#custom-pass",
      submitSelector: "#custom-submit",
    });

    expect(steps).toHaveLength(4);
    expect(steps[1].args).toEqual({
      action: "type",
      selector: "#custom-user",
      text: "user@test.com",
    });
    expect(steps[2].args).toEqual({
      action: "type",
      selector: "#custom-pass",
      text: "secret",
    });
    expect(steps[3].args).toEqual({
      action: "click",
      selector: "#custom-submit",
    });
  });

  it("browseAndAnalyze without screenshotPath uses undefined path", () => {
    const steps = StepPatterns.browseAndAnalyze("https://example.com");

    expect(steps).toHaveLength(3);
    expect(steps[0].id).toBe("navigate");
    expect(steps[1].id).toBe("screenshot");
    expect(steps[1].args).toEqual({ action: "screenshot", path: undefined });
    expect(steps[2].id).toBe("analyze");
  });
});
