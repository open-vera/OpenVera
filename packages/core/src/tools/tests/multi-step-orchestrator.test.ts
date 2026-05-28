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

  it("downloadAndParse returns correct steps", () => {
    const steps = StepPatterns.downloadAndParse(
      "https://example.com",
      "a.download-link",
      "cat ~/Downloads/file.csv",
    );

    expect(steps).toHaveLength(4);
    expect(steps[0].id).toBe("navigate");
    expect(steps[1].id).toBe("click_download");
    expect(steps[2].id).toBe("wait_download");
    expect(steps[3].id).toBe("parse");
    expect(steps[3].args).toEqual({ command: "cat ~/Downloads/file.csv" });
  });
});
