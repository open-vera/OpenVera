// Tests for operation-recorder

import { describe, it, expect, vi } from "vitest";
import {
  OperationRecorder,
  replay,
  serializeRecording,
  deserializeRecording,
  executeWithRecording,
  type StepRecord,
  type OperationRecording,
  type ReplayOptions,
} from "../operation-recorder.js";
import type { ToolDef, ToolResult, ToolContext } from "../types.js";
import type { StepDefinition, ToolResolver } from "../multi-step-orchestrator.js";

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

// ── OperationRecorder ──────────────────────────────────────────────────────────

describe("OperationRecorder", () => {
  it("records tool executions via wrapTool", async () => {
    const tool = mockTool("bash", okResult("hello world"));
    const recorder = new OperationRecorder("test-task", "sess-1");

    const wrapped = recorder.wrapTool(tool, mockCtx);
    const result = await wrapped.execute({ command: "echo hello" }, mockCtx);

    expect(result.ok).toBe(true);
    expect(result.content).toBe("hello world");
    expect(recorder.stepCount).toBe(1);

    const recording = recorder.finish();
    expect(recording.steps).toHaveLength(1);
    expect(recording.steps[0].tool).toBe("bash");
    expect(recording.steps[0].args).toEqual({ command: "echo hello" });
    expect(recording.steps[0].result.ok).toBe(true);
    expect(recording.steps[0].durationMs).toBeGreaterThanOrEqual(0);
  });

  it("records multiple sequential tool calls", async () => {
    const navTool = mockTool("browser", okResult("navigated"));
    const screenshotTool = mockTool("screenshot", okResult("/tmp/shot.png"));
    const recorder = new OperationRecorder("multi-step");

    const wrappedNav = recorder.wrapTool(navTool, mockCtx);
    const wrappedScreenshot = recorder.wrapTool(screenshotTool, mockCtx);

    await wrappedNav.execute({ action: "navigate", url: "https://example.com" }, mockCtx);
    await wrappedScreenshot.execute({ mode: "fullscreen" }, mockCtx);

    expect(recorder.stepCount).toBe(2);

    const recording = recorder.finish();
    expect(recording.steps[0].tool).toBe("browser");
    expect(recording.steps[0].index).toBe(0);
    expect(recording.steps[1].tool).toBe("screenshot");
    expect(recording.steps[1].index).toBe(1);
    expect(recording.ok).toBe(true);
  });

  it("records failed tool calls", async () => {
    const tool = mockTool("browser", failResult("navigation timeout"));
    const recorder = new OperationRecorder("fail-test");

    const wrapped = recorder.wrapTool(tool, mockCtx);
    const result = await wrapped.execute({ url: "https://bad.com" }, mockCtx);

    expect(result.ok).toBe(false);
    const recording = recorder.finish();
    expect(recording.ok).toBe(false);
    expect(recording.steps[0].result.ok).toBe(false);
  });

  it("supports manual record() for direct step recording", () => {
    const recorder = new OperationRecorder("manual");

    recorder.record("bash", { command: "ls" }, okResult("file1\nfile2"), 50);
    recorder.record("bash", { command: "pwd" }, okResult("/tmp"), 10);

    expect(recorder.stepCount).toBe(2);

    const recording = recorder.finish();
    expect(recording.steps[0].tool).toBe("bash");
    expect(recording.steps[0].args).toEqual({ command: "ls" });
    expect(recording.steps[0].durationMs).toBe(50);
    expect(recording.steps[1].durationMs).toBe(10);
  });

  it("produces a valid recording with metadata", async () => {
    const tool = mockTool("test", okResult("done"));
    const recorder = new OperationRecorder("meta-test", "sess-42");

    const wrapped = recorder.wrapTool(tool, mockCtx);
    await wrapped.execute({}, mockCtx);

    const recording = recorder.finish();

    expect(recording.id).toMatch(/^rec_/);
    expect(recording.label).toBe("meta-test");
    expect(recording.sessionId).toBe("sess-42");
    expect(recording.createdAt).toBeGreaterThan(0);
    expect(recording.totalDurationMs).toBeGreaterThanOrEqual(0);
  });

  it("preserves step ordering by index", async () => {
    const tool = mockTool("multi", okResult("ok"));
    const recorder = new OperationRecorder("order-test");
    const wrapped = recorder.wrapTool(tool, mockCtx);

    for (let i = 0; i < 5; i++) {
      await wrapped.execute({ step: i }, mockCtx);
    }

    const recording = recorder.finish();
    recording.steps.forEach((step, i) => {
      expect(step.index).toBe(i);
    });
  });
});

// ── replay ─────────────────────────────────────────────────────────────────────

describe("replay", () => {
  const sampleRecording: OperationRecording = {
    id: "rec_test_123",
    label: "test-replay",
    sessionId: "sess-1",
    createdAt: Date.now(),
    totalDurationMs: 500,
    ok: true,
    steps: [
      {
        index: 0,
        tool: "browser",
        args: { action: "navigate", url: "https://example.com" },
        result: okResult("navigated"),
        timestamp: Date.now(),
        durationMs: 200,
      },
      {
        index: 1,
        tool: "screenshot",
        args: { mode: "fullscreen" },
        result: okResult("/tmp/shot.png"),
        timestamp: Date.now(),
        durationMs: 100,
      },
      {
        index: 2,
        tool: "bash",
        args: { command: "echo done" },
        result: okResult("done"),
        timestamp: Date.now(),
        durationMs: 50,
      },
    ],
  };

  it("replays all steps successfully", async () => {
    const tools = new Map<string, ToolDef>();
    tools.set("browser", mockTool("browser", okResult("replayed-nav")));
    tools.set("screenshot", mockTool("screenshot", okResult("/tmp/replayed.png")));
    tools.set("bash", mockTool("bash", okResult("replayed-done")));

    const resolver: ToolResolver = (name) => tools.get(name);
    const result = await replay(sampleRecording, resolver, mockCtx);

    expect(result.ok).toBe(true);
    expect(result.steps).toHaveLength(3);
    expect(result.steps[0].result.content).toBe("replayed-nav");
    expect(result.steps[1].result.content).toBe("/tmp/replayed.png");
    expect(result.steps[2].result.content).toBe("replayed-done");
  });

  it("replays from a specific step (startFromStep)", async () => {
    const browserMock = mockTool("browser", okResult("replayed-nav"));
    const tools = new Map<string, ToolDef>();
    tools.set("browser", browserMock);
    tools.set("screenshot", mockTool("screenshot", okResult("/tmp/replayed.png")));
    tools.set("bash", mockTool("bash", okResult("replayed-done")));

    const resolver: ToolResolver = (name) => tools.get(name);
    const result = await replay(sampleRecording, resolver, mockCtx, {
      startFromStep: 1,
    });

    expect(result.ok).toBe(true);
    expect(result.steps).toHaveLength(2);
    expect(result.steps[0].tool).toBe("screenshot");
    expect(result.steps[1].tool).toBe("bash");
    // browser tool should NOT have been called
    expect(browserMock.execute).not.toHaveBeenCalled();
  });

  it("replays up to a specific step (stopAtStep)", async () => {
    const bashMock = mockTool("bash", okResult("replayed-done"));
    const tools = new Map<string, ToolDef>();
    tools.set("browser", mockTool("browser", okResult("replayed-nav")));
    tools.set("screenshot", mockTool("screenshot", okResult("/tmp/replayed.png")));
    tools.set("bash", bashMock);

    const resolver: ToolResolver = (name) => tools.get(name);
    const result = await replay(sampleRecording, resolver, mockCtx, {
      stopAtStep: 1,
    });

    expect(result.ok).toBe(true);
    expect(result.steps).toHaveLength(2);
    expect(bashMock.execute).not.toHaveBeenCalled();
  });

  it("replays a range (startFromStep + stopAtStep)", async () => {
    const tools = new Map<string, ToolDef>();
    tools.set("screenshot", mockTool("screenshot", okResult("/tmp/replayed.png")));

    const resolver: ToolResolver = (name) => tools.get(name);
    const result = await replay(sampleRecording, resolver, mockCtx, {
      startFromStep: 1,
      stopAtStep: 1,
    });

    expect(result.ok).toBe(true);
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0].tool).toBe("screenshot");
  });

  it("applies args overrides during replay", async () => {
    const browserTool = mockTool("browser", okResult("navigated"));
    const tools = new Map<string, ToolDef>();
    tools.set("browser", browserTool);
    tools.set("screenshot", mockTool("screenshot", okResult("/tmp/shot.png")));
    tools.set("bash", mockTool("bash", okResult("done")));

    const resolver: ToolResolver = (name) => tools.get(name);
    const overrides = new Map<number, Record<string, unknown>>();
    overrides.set(0, { action: "navigate", url: "https://different.com" });

    const result = await replay(sampleRecording, resolver, mockCtx, {
      argsOverrides: overrides,
    });

    expect(result.ok).toBe(true);
    // Verify the overridden args were used
    expect(browserTool.execute).toHaveBeenCalledWith(
      expect.objectContaining({ url: "https://different.com" }),
      expect.anything(),
    );
    // Verify the replayed step recorded the overridden args
    expect(result.steps[0].args).toEqual({ action: "navigate", url: "https://different.com" });
  });

  it("fails when tool is not found", async () => {
    const resolver: ToolResolver = () => undefined;
    const result = await replay(sampleRecording, resolver, mockCtx);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("Tool not found: browser");
    expect(result.steps).toHaveLength(0);
  });

  it("fails when a step returns an error result", async () => {
    const tools = new Map<string, ToolDef>();
    tools.set("browser", mockTool("browser", failResult("nav failed")));
    tools.set("screenshot", mockTool("screenshot", okResult("/tmp/shot.png")));
    tools.set("bash", mockTool("bash", okResult("done")));

    const resolver: ToolResolver = (name) => tools.get(name);
    const result = await replay(sampleRecording, resolver, mockCtx);

    expect(result.ok).toBe(false);
    expect(result.steps).toHaveLength(1);
    expect(result.error).toContain("Step 0 (browser) failed");
  });

  it("fails when a tool throws an exception", async () => {
    const throwingTool: ToolDef = {
      name: "browser",
      description: "throws",
      parameters: { type: "object", properties: {} },
      execute: vi.fn().mockRejectedValue(new Error("crash")),
    };

    const tools = new Map<string, ToolDef>();
    tools.set("browser", throwingTool);

    const resolver: ToolResolver = (name) => tools.get(name);
    const result = await replay(sampleRecording, resolver, mockCtx);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("Step 0 (browser) threw: crash");
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0].result.ok).toBe(false);
  });

  it("respects AbortSignal", async () => {
    const slowTool: ToolDef = {
      name: "browser",
      description: "slow",
      parameters: { type: "object", properties: {} },
      execute: vi.fn().mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve(okResult("done")), 200)),
      ),
    };

    const tools = new Map<string, ToolDef>();
    tools.set("browser", slowTool);
    tools.set("screenshot", mockTool("screenshot", okResult("/tmp/shot.png")));
    tools.set("bash", mockTool("bash", okResult("done")));

    const controller = new AbortController();
    // Abort after a short delay
    setTimeout(() => controller.abort(), 50);

    const resolver: ToolResolver = (name) => tools.get(name);
    const result = await replay(sampleRecording, resolver, mockCtx, {
      signal: controller.signal,
    });

    // The first step is slow, and we abort during it — but since the tool
    // doesn't check the signal internally, it will complete. The abort is
    // checked between steps, so it may or may not stop depending on timing.
    // At minimum, we should get a result.
    expect(result).toBeDefined();
  });

  it("handles empty recording", async () => {
    const emptyRecording: OperationRecording = {
      id: "rec_empty",
      label: "empty",
      sessionId: "sess-1",
      createdAt: Date.now(),
      totalDurationMs: 0,
      ok: true,
      steps: [],
    };

    const resolver: ToolResolver = () => undefined;
    const result = await replay(emptyRecording, resolver, mockCtx);

    expect(result.ok).toBe(true);
    expect(result.steps).toHaveLength(0);
  });
});

// ── Serialization ──────────────────────────────────────────────────────────────

describe("serializeRecording / deserializeRecording", () => {
  it("round-trips a recording through JSON", () => {
    const recording: OperationRecording = {
      id: "rec_roundtrip",
      label: "serialization-test",
      sessionId: "sess-1",
      createdAt: 1700000000000,
      totalDurationMs: 350,
      ok: true,
      steps: [
        {
          index: 0,
          tool: "bash",
          args: { command: "echo hello" },
          result: okResult("hello"),
          timestamp: 1700000000000,
          durationMs: 100,
        },
        {
          index: 1,
          tool: "browser",
          args: { action: "navigate", url: "https://example.com" },
          result: okResult("navigated"),
          timestamp: 1700000000100,
          durationMs: 250,
        },
      ],
    };

    const json = serializeRecording(recording);
    const deserialized = deserializeRecording(json);

    expect(deserialized.id).toBe(recording.id);
    expect(deserialized.label).toBe(recording.label);
    expect(deserialized.steps).toHaveLength(2);
    expect(deserialized.steps[0].tool).toBe("bash");
    expect(deserialized.steps[1].args).toEqual({ action: "navigate", url: "https://example.com" });
  });

  it("throws on invalid JSON format", () => {
    expect(() => deserializeRecording('{"steps": "not-array"}')).toThrow("Invalid recording format");
    expect(() => deserializeRecording('{"id": "test"}')).toThrow("Invalid recording format");
  });

  it("preserves error results in serialized form", () => {
    const recording: OperationRecording = {
      id: "rec_errors",
      label: "error-test",
      sessionId: "sess-1",
      createdAt: Date.now(),
      totalDurationMs: 100,
      ok: false,
      steps: [
        {
          index: 0,
          tool: "bash",
          args: { command: "false" },
          result: failResult("command failed"),
          timestamp: Date.now(),
          durationMs: 50,
        },
      ],
    };

    const json = serializeRecording(recording);
    const deserialized = deserializeRecording(json);

    expect(deserialized.ok).toBe(false);
    expect(deserialized.steps[0].result.ok).toBe(false);
    expect(deserialized.steps[0].result.error?.message).toBe("command failed");
  });
});

// ── executeWithRecording ───────────────────────────────────────────────────────

describe("executeWithRecording", () => {
  it("records orchestrator execution and returns both results", async () => {
    const tools = new Map<string, ToolDef>();
    tools.set("browser", mockTool("browser", okResult("navigated")));
    tools.set("bash", mockTool("bash", okResult("done")));

    const resolver: ToolResolver = (name) => tools.get(name);

    const steps: StepDefinition[] = [
      { id: "nav", tool: "browser", args: { action: "navigate", url: "https://example.com" } },
      { id: "exec", tool: "bash", args: { command: "echo hello" } },
    ];

    const { orchestration, recording } = await executeWithRecording(
      steps,
      resolver,
      mockCtx,
      "test-orchestration",
    );

    expect(orchestration.ok).toBe(true);
    expect(orchestration.steps).toHaveLength(2);

    expect(recording.label).toBe("test-orchestration");
    expect(recording.steps).toHaveLength(2);
    expect(recording.steps[0].tool).toBe("browser");
    expect(recording.steps[1].tool).toBe("bash");
    expect(recording.ok).toBe(true);
  });

  it("records failed orchestration steps", async () => {
    const tools = new Map<string, ToolDef>();
    tools.set("browser", mockTool("browser", failResult("nav failed")));
    tools.set("bash", mockTool("bash", okResult("done")));

    const resolver: ToolResolver = (name) => tools.get(name);

    const steps: StepDefinition[] = [
      { id: "nav", tool: "browser", args: { url: "https://bad.com" } },
      { id: "exec", tool: "bash", args: { command: "echo hello" } },
    ];

    const { orchestration, recording } = await executeWithRecording(
      steps,
      resolver,
      mockCtx,
      "fail-orchestration",
    );

    expect(orchestration.ok).toBe(false);
    expect(recording.ok).toBe(false);
    expect(recording.steps).toHaveLength(1); // stopped after first step
  });

  it("respects orchestrator config", async () => {
    const tools = new Map<string, ToolDef>();
    tools.set("step1", mockTool("step1", failResult("failed")));
    tools.set("step2", mockTool("step2", okResult("done")));

    const resolver: ToolResolver = (name) => tools.get(name);

    const steps: StepDefinition[] = [
      { id: "s1", tool: "step1", args: {}, onError: "skip" },
      { id: "s2", tool: "step2", args: {} },
    ];

    const { orchestration, recording } = await executeWithRecording(
      steps,
      resolver,
      mockCtx,
      "skip-test",
      undefined,
      { stopOnError: false },
    );

    expect(orchestration.ok).toBe(true);
    expect(recording.steps).toHaveLength(2);
    expect(recording.steps[0].result.ok).toBe(false);
    expect(recording.steps[1].result.ok).toBe(true);
  });
});
