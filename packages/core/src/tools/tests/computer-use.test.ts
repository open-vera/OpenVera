/**
 * Tests for computer_use meta-tool (CU10)
 *
 * Verifies: unified entry point, environment auto-detection,
 * sub-tool routing, composite task decomposition, orchestrator integration.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ToolContext, ToolResult } from "../types.js";

// ── Mock sub-tools (vi.hoisted ensures they're available before vi.mock) ─────

const mockBrowserResult: ToolResult = { ok: true, content: "browser: navigated" };
const mockScreenshotResult: ToolResult = { ok: true, content: "screenshot saved" };
const mockInputResult: ToolResult = { ok: true, content: "clicked at (100, 200)" };
const mockScriptResult: ToolResult = { ok: true, content: "script output" };
const mockAccessibilityResult: ToolResult = { ok: true, content: "accessibility data" };
const mockBashResult: ToolResult = { ok: true, content: "command output" };

const mockVisualAnalyzeResult: ToolResult = {
  ok: true,
  content: "## Description\nA browser page.\n\n## Suggested Actions\n1. Click login",
};

const {
  mockBrowserExecute,
  mockScreenshotExecute,
  mockInputExecute,
  mockScriptExecute,
  mockAccessibilityExecute,
  mockBashExecute,
  mockVisualAnalyzeExecute,
} = vi.hoisted(() => ({
  mockBrowserExecute: vi.fn().mockResolvedValue({ ok: true, content: "browser: navigated" }),
  mockScreenshotExecute: vi.fn().mockResolvedValue({ ok: true, content: "screenshot saved" }),
  mockInputExecute: vi.fn().mockResolvedValue({ ok: true, content: "clicked at (100, 200)" }),
  mockScriptExecute: vi.fn().mockResolvedValue({ ok: true, content: "script output" }),
  mockAccessibilityExecute: vi.fn().mockResolvedValue({ ok: true, content: "accessibility data" }),
  mockBashExecute: vi.fn().mockResolvedValue({ ok: true, content: "command output" }),
  mockVisualAnalyzeExecute: vi.fn().mockResolvedValue({
    ok: true,
    content: "## Description\nA browser page.\n\n## Suggested Actions\n1. Click login",
  }),
}));

vi.mock("../browser.js", () => ({
  browserTool: { execute: mockBrowserExecute },
  closeAllBrowserSessions: vi.fn(),
}));

vi.mock("../desktop-screenshot.js", () => ({
  desktopScreenshotTool: { execute: mockScreenshotExecute },
}));

vi.mock("../desktop-input.js", () => ({
  desktopInputTool: { execute: mockInputExecute },
}));

vi.mock("../desktop-script.js", () => ({
  desktopScriptTool: { execute: mockScriptExecute },
}));

vi.mock("../desktop-accessibility.js", () => ({
  desktopAccessibilityTool: { execute: mockAccessibilityExecute },
}));

vi.mock("../bash.js", () => ({
  bashTool: { execute: mockBashExecute },
}));

vi.mock("../visual-analyze.js", () => {
  return {
    createVisualAnalyzeTool: vi.fn((_adapter?: unknown, _model?: string) => ({
      name: "visual_analyze",
      description: "mock visual analyze",
      parameters: { type: "object", properties: {} },
      execute: mockVisualAnalyzeExecute,
    })),
  };
});

// ── Import after mock ─────────────────────────────────────────────────────────

import { computerUseTool } from "../computer-use.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

const mockCtx: ToolContext = {
  cwd: "/tmp/test",
  sessionId: "test-session",
};

function makeLLMCtx(): ToolContext {
  return {
    ...mockCtx,
    llmAdapter: { complete: vi.fn(), stream: vi.fn() },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("CU10: computer_use meta-tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Re-setup mock implementations after clearAllMocks
    mockBrowserExecute.mockResolvedValue(mockBrowserResult);
    mockScreenshotExecute.mockResolvedValue(mockScreenshotResult);
    mockInputExecute.mockResolvedValue(mockInputResult);
    mockScriptExecute.mockResolvedValue(mockScriptResult);
    mockAccessibilityExecute.mockResolvedValue(mockAccessibilityResult);
    mockBashExecute.mockResolvedValue(mockBashResult);
    mockVisualAnalyzeExecute.mockResolvedValue(mockVisualAnalyzeResult);
  });

  // ── Tool registration ───────────────────────────────────────────────────────

  it("should have correct name and description", () => {
    expect(computerUseTool.name).toBe("computer_use");
    expect(computerUseTool.description).toContain("Unified computer use tool");
    expect(computerUseTool.description).toContain("browser");
    expect(computerUseTool.description).toContain("desktop");
    expect(computerUseTool.description).toContain("CLI");
  });

  it("should have correct options", () => {
    expect(computerUseTool.options).toBeDefined();
    expect(computerUseTool.options!.timeoutMs).toBe(120_000);
    expect(computerUseTool.options!.riskLevel).toBe("medium");
  });

  it("should require 'task' parameter", () => {
    const params = computerUseTool.parameters as { required: string[]; properties: Record<string, unknown> };
    expect(params.required).toContain("task");
    expect(params.properties.task).toBeDefined();
  });

  it("should have all expected parameters", () => {
    const props = (computerUseTool.parameters as { properties: Record<string, unknown> }).properties;
    expect(props.task).toBeDefined();
    expect(props.environment).toBeDefined();
    expect(props.action).toBeDefined();
    expect(props.url).toBeDefined();
    expect(props.selector).toBeDefined();
    expect(props.text).toBeDefined();
    expect(props.command).toBeDefined();
    expect(props.screenshotPath).toBeDefined();
    expect(props.timeout).toBeDefined();
  });

  // ── Environment auto-detection ──────────────────────────────────────────────

  it("should detect browser environment from URL", async () => {
    await computerUseTool.execute(
      { task: "navigate to https://example.com" },
      mockCtx,
    );
    expect(mockBrowserExecute).toHaveBeenCalled();
  });

  it("should detect browser environment from keywords", async () => {
    const result = await computerUseTool.execute(
      { task: "open the website and take a screenshot" },
      mockCtx,
    );
    expect(mockBrowserExecute).toHaveBeenCalled();
  });

  it("should detect CLI environment from command keywords", async () => {
    await computerUseTool.execute(
      { task: "run command to install dependencies", command: "npm install" },
      mockCtx,
    );
    expect(mockBashExecute).toHaveBeenCalled();
  });

  it("should detect desktop environment from keywords", async () => {
    await computerUseTool.execute(
      { task: "click at position 100, 200 on the desktop", x: 100, y: 200 },
      mockCtx,
    );
    expect(mockInputExecute).toHaveBeenCalled();
  });

  it("should default to CLI for ambiguous tasks with command", async () => {
    await computerUseTool.execute(
      { task: "do something", command: "ls -la" },
      mockCtx,
    );
    expect(mockBashExecute).toHaveBeenCalled();
  });

  it("should prefer browser when URL argument is provided even with CLI-like task", async () => {
    // args.url short-circuits detectEnvironment to "browser"
    await computerUseTool.execute(
      { task: "run npm install some stuff", url: "https://example.com" },
      mockCtx,
    );
    expect(mockBrowserExecute).toHaveBeenCalled();
  });

  // ── Explicit environment override ───────────────────────────────────────────

  it("should respect explicit browser environment", async () => {
    await computerUseTool.execute(
      { task: "take a screenshot", environment: "browser" },
      mockCtx,
    );
    expect(mockBrowserExecute).toHaveBeenCalled();
  });

  it("should respect explicit desktop environment", async () => {
    await computerUseTool.execute(
      { task: "take a screenshot", environment: "desktop" },
      mockCtx,
    );
    expect(mockScreenshotExecute).toHaveBeenCalled();
  });

  it("should respect explicit CLI environment", async () => {
    await computerUseTool.execute(
      { task: "list files", environment: "cli", command: "ls" },
      mockCtx,
    );
    expect(mockBashExecute).toHaveBeenCalled();
  });

  it("should respect auto environment detection", async () => {
    // environment: "auto" — re-runs detectEnvironment
    await computerUseTool.execute(
      { task: "open website https://example.com", environment: "auto" },
      mockCtx,
    );
    expect(mockBrowserExecute).toHaveBeenCalled();
  });

  it("should use auto-detect to route to desktop when environment is auto", async () => {
    await computerUseTool.execute(
      { task: "double click on desktop icon", environment: "auto", x: 50, y: 50 },
      mockCtx,
    );
    expect(mockInputExecute).toHaveBeenCalled();
  });

  it("should use auto-detect to route to CLI when environment is auto", async () => {
    await computerUseTool.execute(
      { task: "run git status", environment: "auto", command: "git status" },
      mockCtx,
    );
    expect(mockBashExecute).toHaveBeenCalled();
  });

  it("should return error for unrecognized environment value", async () => {
    const result = await computerUseTool.execute(
      { task: "do something", environment: "unknown" as any },
      mockCtx,
    );
    expect(result.ok).toBe(false);
    expect(result.content).toContain("Unknown environment");
  });

  // ── Browser routing ─────────────────────────────────────────────────────────

  it("should route to browser navigate when url is provided", async () => {
    await computerUseTool.execute(
      { task: "open page", url: "https://example.com" },
      mockCtx,
    );
    expect(mockBrowserExecute).toHaveBeenCalledWith(
      expect.objectContaining({ action: "navigate", url: "https://example.com" }),
      mockCtx,
    );
  });

  it("should route to browser screenshot from task description", async () => {
    await computerUseTool.execute(
      { task: "take a screenshot of the webpage", environment: "browser" },
      mockCtx,
    );
    expect(mockBrowserExecute).toHaveBeenCalledWith(
      expect.objectContaining({ action: "screenshot" }),
      mockCtx,
    );
  });

  it("should route to browser navigate from URL in task text", async () => {
    await computerUseTool.execute(
      { task: "go to https://test.dev and check it out", environment: "browser" },
      mockCtx,
    );
    expect(mockBrowserExecute).toHaveBeenCalledWith(
      expect.objectContaining({ action: "navigate", url: "https://test.dev" }),
      mockCtx,
    );
  });

  it("should pass explicit browser action through", async () => {
    await computerUseTool.execute(
      {
        task: "click something",
        environment: "browser",
        action: "click",
        selector: "#submit-btn",
      },
      mockCtx,
    );
    expect(mockBrowserExecute).toHaveBeenCalledWith(
      expect.objectContaining({ action: "click", selector: "#submit-btn" }),
      mockCtx,
    );
  });

  it("should pass timeout to browser sub-tool", async () => {
    await computerUseTool.execute(
      { task: "navigate to https://example.com", timeout: 5000 },
      mockCtx,
    );
    expect(mockBrowserExecute).toHaveBeenCalledWith(
      expect.objectContaining({ timeout: 5000 }),
      mockCtx,
    );
  });

  it("should pass browser action with url and explicit action together", async () => {
    // Covers the `args.action` branch when url is also set
    await computerUseTool.execute(
      {
        task: "evaluate something",
        environment: "browser",
        action: "evaluate",
        url: "https://example.com",
        expression: "document.title",
        text: "hello",
        screenshotPath: "/tmp/cap.png",
      },
      mockCtx,
    );
    expect(mockBrowserExecute).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "evaluate",
        url: "https://example.com",
        expression: "document.title",
        text: "hello",
        path: "/tmp/cap.png",
      }),
      mockCtx,
    );
  });

  // ── Desktop routing ─────────────────────────────────────────────────────────

  it("should route to desktop screenshot from task description", async () => {
    await computerUseTool.execute(
      { task: "take a screenshot of the desktop", environment: "desktop" },
      mockCtx,
    );
    expect(mockScreenshotExecute).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "fullscreen" }),
      mockCtx,
    );
  });

  it("should detect window screenshot mode", async () => {
    await computerUseTool.execute(
      { task: "capture window screenshot", environment: "desktop" },
      mockCtx,
    );
    expect(mockScreenshotExecute).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "window" }),
      mockCtx,
    );
  });

  it("should detect region screenshot mode", async () => {
    await computerUseTool.execute(
      { task: "capture region screenshot of desktop area", environment: "desktop" },
      mockCtx,
    );
    expect(mockScreenshotExecute).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "region" }),
      mockCtx,
    );
  });

  it("should route to desktop click with coordinates", async () => {
    await computerUseTool.execute(
      { task: "click at position", environment: "desktop", x: 150, y: 250 },
      mockCtx,
    );
    expect(mockInputExecute).toHaveBeenCalledWith(
      expect.objectContaining({ action: "click", x: 150, y: 250 }),
      mockCtx,
    );
  });

  it("should detect double click from task", async () => {
    await computerUseTool.execute(
      { task: "double click on the icon", environment: "desktop", x: 100, y: 100 },
      mockCtx,
    );
    expect(mockInputExecute).toHaveBeenCalledWith(
      expect.objectContaining({ action: "doubleClick" }),
      mockCtx,
    );
  });

  it("should detect right click from task", async () => {
    await computerUseTool.execute(
      { task: "right click here", environment: "desktop", x: 200, y: 300 },
      mockCtx,
    );
    expect(mockInputExecute).toHaveBeenCalledWith(
      expect.objectContaining({ action: "rightClick" }),
      mockCtx,
    );
  });

  it("should route to desktop type with text", async () => {
    await computerUseTool.execute(
      { task: "type hello world", environment: "desktop", text: "hello world" },
      mockCtx,
    );
    expect(mockInputExecute).toHaveBeenCalledWith(
      expect.objectContaining({ action: "type", text: "hello world" }),
      mockCtx,
    );
  });

  it("should route to desktop hotkey with modifiers", async () => {
    await computerUseTool.execute(
      {
        task: "press hotkey",
        environment: "desktop",
        key: "c",
        modifiers: ["ctrl"],
      },
      mockCtx,
    );
    expect(mockInputExecute).toHaveBeenCalledWith(
      expect.objectContaining({ action: "hotkey", key: "c", modifiers: ["ctrl"] }),
      mockCtx,
    );
  });

  it("should return error for hotkey task without key and modifiers", async () => {
    // hotkey/shortcut keyword present but no key+modifiers → falls through to error
    const result = await computerUseTool.execute(
      { task: "press a hotkey combination now", environment: "desktop" },
      mockCtx,
    );
    expect(result.ok).toBe(false);
    expect(result.content).toContain("Could not determine desktop action");
  });

  it("should route to desktop script execution", async () => {
    await computerUseTool.execute(
      {
        task: "run a script on the desktop",
        environment: "desktop",
        script: "tell app Finder to activate",
        scriptType: "applescript",
      },
      mockCtx,
    );
    expect(mockScriptExecute).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "applescript",
        script: "tell app Finder to activate",
      }),
      mockCtx,
    );
  });

  it("should use 'shell' as default script type", async () => {
    await computerUseTool.execute(
      {
        task: "run script",
        environment: "desktop",
        script: "echo hello",
      },
      mockCtx,
    );
    expect(mockScriptExecute).toHaveBeenCalledWith(
      expect.objectContaining({ type: "shell" }),
      mockCtx,
    );
  });

  it("should pass explicit inputAction through", async () => {
    await computerUseTool.execute(
      {
        task: "scroll down",
        environment: "desktop",
        inputAction: "scroll",
      },
      mockCtx,
    );
    expect(mockInputExecute).toHaveBeenCalledWith(
      expect.objectContaining({ action: "scroll" }),
      mockCtx,
    );
  });

  it("should pass inputAction with all optional coordinates and modifiers", async () => {
    await computerUseTool.execute(
      {
        task: "do something",
        environment: "desktop",
        inputAction: "move",
        x: 300,
        y: 400,
        text: "typed text",
        key: "enter",
        modifiers: ["shift"],
      },
      mockCtx,
    );
    expect(mockInputExecute).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "move",
        x: 300,
        y: 400,
        text: "typed text",
        key: "enter",
        modifiers: ["shift"],
      }),
      mockCtx,
    );
  });

  // ── CLI routing ─────────────────────────────────────────────────────────────

  it("should route to bash for CLI tasks", async () => {
    await computerUseTool.execute(
      { task: "run a shell command", environment: "cli", command: "echo hello" },
      mockCtx,
    );
    expect(mockBashExecute).toHaveBeenCalledWith(
      expect.objectContaining({ command: "echo hello" }),
      mockCtx,
    );
  });

  it("should return error when CLI task has no command", async () => {
    const result = await computerUseTool.execute(
      { task: "run a command", environment: "cli" },
      mockCtx,
    );
    expect(result.ok).toBe(false);
    expect(result.content).toContain("command is required");
  });

  it("should pass timeout to bash sub-tool", async () => {
    await computerUseTool.execute(
      { task: "run a command", environment: "cli", command: "npm test", timeout: 30000 },
      mockCtx,
    );
    expect(mockBashExecute).toHaveBeenCalledWith(
      expect.objectContaining({ command: "npm test", timeout: 30000 }),
      mockCtx,
    );
  });

  // ── Composite task decomposition ────────────────────────────────────────────

  it("should decompose 'open URL and take screenshot'", async () => {
    const result = await computerUseTool.execute(
      { task: "navigate to https://example.com and take a screenshot" },
      mockCtx,
    );
    expect(result.ok).toBe(true);
    expect(mockBrowserExecute).toHaveBeenCalledTimes(2);
    // First call: navigate
    expect(mockBrowserExecute.mock.calls[0][0]).toEqual(
      expect.objectContaining({ action: "navigate", url: "https://example.com" }),
    );
    // Second call: screenshot
    expect(mockBrowserExecute.mock.calls[1][0]).toEqual(
      expect.objectContaining({ action: "screenshot" }),
    );
  });

  it("should decompose 'open URL and click selector'", async () => {
    const result = await computerUseTool.execute(
      { task: "go to https://app.dev and click #login-button" },
      mockCtx,
    );
    expect(result.ok).toBe(true);
    expect(mockBrowserExecute).toHaveBeenCalledTimes(2);
    expect(mockBrowserExecute.mock.calls[0][0]).toEqual(
      expect.objectContaining({ action: "navigate", url: "https://app.dev" }),
    );
    expect(mockBrowserExecute.mock.calls[1][0]).toEqual(
      expect.objectContaining({ action: "click", selector: "#login-button" }),
    );
  });

  it("should decompose 'open URL and type into selector'", async () => {
    const result = await computerUseTool.execute(
      { task: 'navigate to https://app.dev and type "hello" into #search-input' },
      mockCtx,
    );
    expect(result.ok).toBe(true);
    expect(mockBrowserExecute).toHaveBeenCalledTimes(2);
    expect(mockBrowserExecute.mock.calls[1][0]).toEqual(
      expect.objectContaining({ action: "type", text: "hello", selector: "#search-input" }),
    );
  });

  it("should decompose screenshot-only 'screenshot and analyze' without URL", async () => {
    // Covers the decomposeTask pattern at line 335: screenshot + analyze (no URL)
    const ctxLLM = makeLLMCtx();
    const result = await computerUseTool.execute(
      { task: "take a screenshot and analyze the UI", environment: "desktop" },
      ctxLLM,
    );
    expect(result.ok).toBe(true);
    expect(mockScreenshotExecute).toHaveBeenCalledOnce();
    expect(mockScreenshotExecute).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "fullscreen" }),
      expect.objectContaining({ sessionId: "test-session" }),
    );
    expect(mockVisualAnalyzeExecute).toHaveBeenCalledOnce();
  });

  it("should decompose 'take screenshot then do' pattern", async () => {
    // Covers the "take...screenshot...then" condition in decomposeTask
    const ctxLLM = makeLLMCtx();
    const result = await computerUseTool.execute(
      { task: "take a screenshot then analyze the result", environment: "desktop", screenshotPath: "/tmp/t.png" },
      ctxLLM,
    );
    expect(result.ok).toBe(true);
    expect(mockScreenshotExecute).toHaveBeenCalledOnce();
    expect(mockVisualAnalyzeExecute).toHaveBeenCalledOnce();
    expect(mockVisualAnalyzeExecute).toHaveBeenCalledWith(
      expect.objectContaining({ imagePath: "/tmp/t.png" }),
      ctxLLM,
    );
  });

  it("should decompose URL+screenshot+analyze via second pattern (not navigate/open prefix)", async () => {
    // Covers the decomposeTask pattern at line 275: URL present + screenshot+analyze
    // but NO "open"/"navigate"/"go to" prefix to trigger the FIRST pattern
    const ctxLLM = makeLLMCtx();
    const result = await computerUseTool.execute(
      { task: "capture a screenshot of https://example.com and analyze the page" },
      ctxLLM,
    );
    expect(result.ok).toBe(true);
    // navigate + screenshot + visual_analyze = 3 steps
    expect(mockBrowserExecute).toHaveBeenCalledTimes(2);
    expect(mockBrowserExecute.mock.calls[0][0]).toEqual(
      expect.objectContaining({ action: "navigate", url: "https://example.com" }),
    );
    expect(mockBrowserExecute.mock.calls[1][0]).toEqual(
      expect.objectContaining({ action: "screenshot" }),
    );
    expect(mockVisualAnalyzeExecute).toHaveBeenCalledOnce();
  });

  it("should stop on first failure in composite task", async () => {
    mockBrowserExecute
      .mockResolvedValueOnce({ ok: true, content: "navigated" })
      .mockResolvedValueOnce({
        ok: false,
        content: "click failed",
        error: { code: "EXEC_ERROR", message: "click failed", retryable: false },
      });

    const result = await computerUseTool.execute(
      { task: "go to https://example.com and click #missing" },
      mockCtx,
    );
    expect(result.ok).toBe(false);
    expect(result.content).toContain("✓");
    expect(result.content).toContain("✗");
  });

  it("should catch and report thrown errors during decompose step execution", async () => {
    // First navigate succeeds, second (click) throws
    mockBrowserExecute
      .mockResolvedValueOnce({ ok: true, content: "navigated" })
      .mockRejectedValueOnce(new Error("playwright crash mid-click"));

    const result = await computerUseTool.execute(
      { task: "go to https://example.com and click #fragile-btn" },
      mockCtx,
    );
    expect(result.ok).toBe(false);
    expect(result.content).toContain("✗");
    expect(result.content).toContain("playwright crash mid-click");
  });

  // ── Error handling ──────────────────────────────────────────────────────────

  it("should return error for browser task without URL or action", async () => {
    const result = await computerUseTool.execute(
      { task: "do something with the browser", environment: "browser" },
      mockCtx,
    );
    expect(result.ok).toBe(false);
    expect(result.content).toContain("Could not determine browser action");
  });

  it("should return error for desktop task without sufficient info", async () => {
    const result = await computerUseTool.execute(
      { task: "do something on desktop", environment: "desktop" },
      mockCtx,
    );
    expect(result.ok).toBe(false);
    expect(result.content).toContain("Could not determine desktop action");
  });

  it("should handle sub-tool execution errors gracefully", async () => {
    mockBrowserExecute.mockRejectedValueOnce(new Error("playwright not installed"));
    const result = await computerUseTool.execute(
      { task: "navigate to https://example.com", environment: "browser" },
      mockCtx,
    );
    // The error propagates — the registry handles it
    expect(result.ok).toBe(false);
  });

  // ── Screenshot path forwarding ──────────────────────────────────────────────

  it("should forward screenshotPath to browser screenshot", async () => {
    await computerUseTool.execute(
      {
        task: "take a screenshot",
        environment: "browser",
        screenshotPath: "/tmp/cap.png",
      },
      mockCtx,
    );
    expect(mockBrowserExecute).toHaveBeenCalledWith(
      expect.objectContaining({ action: "screenshot", path: "/tmp/cap.png" }),
      mockCtx,
    );
  });

  it("should forward screenshotPath to desktop screenshot", async () => {
    await computerUseTool.execute(
      {
        task: "take a desktop screenshot",
        environment: "desktop",
        screenshotPath: "/tmp/screen.png",
      },
      mockCtx,
    );
    expect(mockScreenshotExecute).toHaveBeenCalledWith(
      expect.objectContaining({ path: "/tmp/screen.png" }),
      mockCtx,
    );
  });

  // ── Expression forwarding ───────────────────────────────────────────────────

  it("should forward expression to browser evaluate", async () => {
    await computerUseTool.execute(
      {
        task: "evaluate JS",
        environment: "browser",
        action: "evaluate",
        expression: "document.title",
      },
      mockCtx,
    );
    expect(mockBrowserExecute).toHaveBeenCalledWith(
      expect.objectContaining({ action: "evaluate", expression: "document.title" }),
      mockCtx,
    );
  });

  // ── Visual analyze integration (CU11) ────────────────────────────────────

  it("should decompose 'screenshot and analyze' with URL into navigate + screenshot + visual_analyze", async () => {
    const mockAdapter = { complete: vi.fn(), stream: vi.fn() };
    const ctxWithLLM: ToolContext = { ...mockCtx, llmAdapter: mockAdapter };

    const result = await computerUseTool.execute(
      {
        task: "navigate to https://example.com and analyze the screenshot",
        screenshotPath: "/tmp/s.png",
      },
      ctxWithLLM,
    );

    expect(result.ok).toBe(true);
    // navigate + screenshot + visual_analyze
    expect(mockBrowserExecute).toHaveBeenCalledTimes(2);
    expect(mockVisualAnalyzeExecute).toHaveBeenCalledOnce();
    expect(mockVisualAnalyzeExecute).toHaveBeenCalledWith(
      expect.objectContaining({ imagePath: "/tmp/s.png" }),
      ctxWithLLM,
    );
  });

  it("should decompose desktop 'screenshot and analyze' into screenshot + visual_analyze", async () => {
    const mockAdapter = { complete: vi.fn(), stream: vi.fn() };
    const ctxWithLLM: ToolContext = { ...mockCtx, llmAdapter: mockAdapter };

    const result = await computerUseTool.execute(
      {
        task: "take a screenshot and analyze it",
        environment: "desktop",
        screenshotPath: "/tmp/d.png",
      },
      ctxWithLLM,
    );

    expect(result.ok).toBe(true);
    expect(mockScreenshotExecute).toHaveBeenCalledOnce();
    expect(mockVisualAnalyzeExecute).toHaveBeenCalledOnce();
    expect(mockVisualAnalyzeExecute).toHaveBeenCalledWith(
      expect.objectContaining({ imagePath: "/tmp/d.png" }),
      ctxWithLLM,
    );
  });

  it("should return error when visual_analyze needs llmAdapter but none provided", async () => {
    const result = await computerUseTool.execute(
      { task: "navigate to https://example.com and analyze the screenshot" },
      mockCtx, // no llmAdapter
    );

    expect(result.ok).toBe(false);
    expect(result.content).toContain("LLM adapter not available");
  });

  it("should stop composite task if visual_analyze fails", async () => {
    const mockAdapter = { complete: vi.fn(), stream: vi.fn() };
    const ctxWithLLM: ToolContext = { ...mockCtx, llmAdapter: mockAdapter };
    mockVisualAnalyzeExecute.mockResolvedValueOnce({
      ok: false,
      content: "analysis failed",
      error: { code: "EXEC_ERROR", message: "analysis failed", retryable: false },
    });

    const result = await computerUseTool.execute(
      { task: "take a screenshot and analyze it", environment: "desktop" },
      ctxWithLLM,
    );

    expect(result.ok).toBe(false);
    expect(result.content).toContain("✗");
  });

  // ── Multi-step orchestrator integration ──────────────────────────────────

  describe("orchestrator flows", () => {
    it("should orchestrate login flow and return multi-step summary", async () => {
      const result = await computerUseTool.execute(
        { task: "login to https://example.com", text: "myuser" },
        mockCtx,
      );

      expect(result.ok).toBe(true);
      expect(result.content).toContain("Multi-step orchestration");
      // login = 4 steps: navigate → fill_username → fill_password → submit
      expect(mockBrowserExecute).toHaveBeenCalledTimes(4);
      // Step 1: navigate
      expect(mockBrowserExecute.mock.calls[0][0]).toEqual(
        expect.objectContaining({ action: "navigate", url: "https://example.com" }),
      );
      // Step 2: fill username
      expect(mockBrowserExecute.mock.calls[1][0]).toEqual(
        expect.objectContaining({ action: "type" }),
      );
      // Step 3: fill password
      expect(mockBrowserExecute.mock.calls[2][0]).toEqual(
        expect.objectContaining({ action: "type" }),
      );
      // Step 4: submit
      expect(mockBrowserExecute.mock.calls[3][0]).toEqual(
        expect.objectContaining({ action: "click" }),
      );
    });

    it("should not trigger orchestrator for 'click login-button' tasks", async () => {
      // "click #login-button" contains "click" → isLoginTask = false
      const result = await computerUseTool.execute(
        { task: "click #login-button on https://example.com", environment: "browser" },
        mockCtx,
      );
      // Should fall through to simple dispatch, not orchestrator
      expect(result.content).not.toContain("Multi-step orchestration");
    });

    it("should not trigger orchestrator for tasks without URL", async () => {
      // "login to my account" has no URL → urlMatch is null → orchestrator returns null
      const result = await computerUseTool.execute(
        { task: "login to my account", environment: "browser" },
        mockCtx,
      );
      expect(result.content).not.toContain("Multi-step orchestration");
    });

    it("should stop orchestrator on first failure (stopOnError)", async () => {
      mockBrowserExecute.mockResolvedValueOnce({
        ok: false,
        content: "navigate failed",
        error: { code: "EXEC_ERROR", message: "DNS error", retryable: false },
      });

      const result = await computerUseTool.execute(
        { task: "sign in to https://example.com", text: "admin" },
        mockCtx,
      );

      expect(result.ok).toBe(false);
      expect(result.content).toContain("Multi-step orchestration");
      // Only the navigate step executed before aborting
      expect(mockBrowserExecute).toHaveBeenCalledTimes(1);
    });

    it("should orchestrate download and parse flow", async () => {
      const result = await computerUseTool.execute(
        { task: "open https://example.com download #report-csv then parse cat ~/Downloads/report.csv" },
        mockCtx,
      );

      expect(result.ok).toBe(true);
      expect(result.content).toContain("Multi-step orchestration");
      // downloadAndParse = 4 steps: navigate + click_download (browser) + wait_download + parse (bash)
      expect(mockBrowserExecute).toHaveBeenCalledTimes(2);
      expect(mockBashExecute).toHaveBeenCalledTimes(2);
    });

    it("should include skipped steps in orchestrator summary", async () => {
      // fill_username condition: ref "navigate" must succeed
      // Make navigate fail → fill_username is skipped
      mockBrowserExecute.mockResolvedValueOnce({
        ok: false,
        content: "navigate failed",
        error: { code: "EXEC_ERROR", message: "DNS error", retryable: false },
      });

      const result = await computerUseTool.execute(
        { task: "sign in to https://example.com", text: "admin" },
        mockCtx,
      );

      expect(result.ok).toBe(false);
      // The first step failed, orchestrator aborted with stopOnError=true
      // So only 1 step result in the summary
      expect(result.content).toContain("[navigate]");
      expect(result.content).toContain("✗");
    });
  });
});
