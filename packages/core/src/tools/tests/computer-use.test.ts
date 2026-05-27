/**
 * Tests for computer_use meta-tool (CU10)
 *
 * Verifies: unified entry point, environment auto-detection,
 * sub-tool routing, composite task decomposition.
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

const { mockBrowserExecute, mockScreenshotExecute, mockInputExecute, mockScriptExecute, mockAccessibilityExecute, mockBashExecute } = vi.hoisted(() => ({
  mockBrowserExecute: vi.fn().mockResolvedValue({ ok: true, content: "browser: navigated" }),
  mockScreenshotExecute: vi.fn().mockResolvedValue({ ok: true, content: "screenshot saved" }),
  mockInputExecute: vi.fn().mockResolvedValue({ ok: true, content: "clicked at (100, 200)" }),
  mockScriptExecute: vi.fn().mockResolvedValue({ ok: true, content: "script output" }),
  mockAccessibilityExecute: vi.fn().mockResolvedValue({ ok: true, content: "accessibility data" }),
  mockBashExecute: vi.fn().mockResolvedValue({ ok: true, content: "command output" }),
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

// ── Import after mock ─────────────────────────────────────────────────────────

import { computerUseTool } from "../computer-use.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

const mockCtx: ToolContext = {
  cwd: "/tmp/test",
  sessionId: "test-session",
};

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
  });

  // ── Tool registration ───────────────────────────────────────────────────────

  it("should have correct name and description", () => {
    expect(computerUseTool.name).toBe("computer_use");
    expect(computerUseTool.description).toContain("Unified computer use tool");
    expect(computerUseTool.description).toContain("browser");
    expect(computerUseTool.description).toContain("desktop");
    expect(computerUseTool.description).toContain("CLI");
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
      mockCtx
    );
    expect(mockBrowserExecute).toHaveBeenCalled();
  });

  it("should detect browser environment from keywords", async () => {
    const result = await computerUseTool.execute(
      { task: "open the website and take a screenshot" },
      mockCtx
    );
    expect(mockBrowserExecute).toHaveBeenCalled();
  });

  it("should detect CLI environment from command keywords", async () => {
    await computerUseTool.execute(
      { task: "run command to install dependencies", command: "npm install" },
      mockCtx
    );
    expect(mockBashExecute).toHaveBeenCalled();
  });

  it("should detect desktop environment from keywords", async () => {
    await computerUseTool.execute(
      { task: "click at position 100, 200 on the desktop", x: 100, y: 200 },
      mockCtx
    );
    expect(mockInputExecute).toHaveBeenCalled();
  });

  it("should default to CLI for ambiguous tasks with command", async () => {
    await computerUseTool.execute(
      { task: "do something", command: "ls -la" },
      mockCtx
    );
    expect(mockBashExecute).toHaveBeenCalled();
  });

  // ── Explicit environment override ───────────────────────────────────────────

  it("should respect explicit browser environment", async () => {
    await computerUseTool.execute(
      { task: "take a screenshot", environment: "browser" },
      mockCtx
    );
    expect(mockBrowserExecute).toHaveBeenCalled();
  });

  it("should respect explicit desktop environment", async () => {
    await computerUseTool.execute(
      { task: "take a screenshot", environment: "desktop" },
      mockCtx
    );
    expect(mockScreenshotExecute).toHaveBeenCalled();
  });

  it("should respect explicit CLI environment", async () => {
    await computerUseTool.execute(
      { task: "list files", environment: "cli", command: "ls" },
      mockCtx
    );
    expect(mockBashExecute).toHaveBeenCalled();
  });

  // ── Browser routing ─────────────────────────────────────────────────────────

  it("should route to browser navigate when url is provided", async () => {
    await computerUseTool.execute(
      { task: "open page", url: "https://example.com" },
      mockCtx
    );
    expect(mockBrowserExecute).toHaveBeenCalledWith(
      expect.objectContaining({ action: "navigate", url: "https://example.com" }),
      mockCtx
    );
  });

  it("should route to browser screenshot from task description", async () => {
    await computerUseTool.execute(
      { task: "take a screenshot of the webpage", environment: "browser" },
      mockCtx
    );
    expect(mockBrowserExecute).toHaveBeenCalledWith(
      expect.objectContaining({ action: "screenshot" }),
      mockCtx
    );
  });

  it("should route to browser navigate from URL in task text", async () => {
    await computerUseTool.execute(
      { task: "go to https://test.dev and check it out", environment: "browser" },
      mockCtx
    );
    expect(mockBrowserExecute).toHaveBeenCalledWith(
      expect.objectContaining({ action: "navigate", url: "https://test.dev" }),
      mockCtx
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
      mockCtx
    );
    expect(mockBrowserExecute).toHaveBeenCalledWith(
      expect.objectContaining({ action: "click", selector: "#submit-btn" }),
      mockCtx
    );
  });

  it("should pass timeout to browser sub-tool", async () => {
    await computerUseTool.execute(
      { task: "navigate to https://example.com", timeout: 5000 },
      mockCtx
    );
    expect(mockBrowserExecute).toHaveBeenCalledWith(
      expect.objectContaining({ timeout: 5000 }),
      mockCtx
    );
  });

  // ── Desktop routing ─────────────────────────────────────────────────────────

  it("should route to desktop screenshot from task description", async () => {
    await computerUseTool.execute(
      { task: "take a screenshot of the desktop", environment: "desktop" },
      mockCtx
    );
    expect(mockScreenshotExecute).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "fullscreen" }),
      mockCtx
    );
  });

  it("should detect window screenshot mode", async () => {
    await computerUseTool.execute(
      { task: "capture window screenshot", environment: "desktop" },
      mockCtx
    );
    expect(mockScreenshotExecute).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "window" }),
      mockCtx
    );
  });

  it("should route to desktop click with coordinates", async () => {
    await computerUseTool.execute(
      { task: "click at position", environment: "desktop", x: 150, y: 250 },
      mockCtx
    );
    expect(mockInputExecute).toHaveBeenCalledWith(
      expect.objectContaining({ action: "click", x: 150, y: 250 }),
      mockCtx
    );
  });

  it("should detect double click from task", async () => {
    await computerUseTool.execute(
      { task: "double click on the icon", environment: "desktop", x: 100, y: 100 },
      mockCtx
    );
    expect(mockInputExecute).toHaveBeenCalledWith(
      expect.objectContaining({ action: "doubleClick" }),
      mockCtx
    );
  });

  it("should detect right click from task", async () => {
    await computerUseTool.execute(
      { task: "right click here", environment: "desktop", x: 200, y: 300 },
      mockCtx
    );
    expect(mockInputExecute).toHaveBeenCalledWith(
      expect.objectContaining({ action: "rightClick" }),
      mockCtx
    );
  });

  it("should route to desktop type with text", async () => {
    await computerUseTool.execute(
      { task: "type hello world", environment: "desktop", text: "hello world" },
      mockCtx
    );
    expect(mockInputExecute).toHaveBeenCalledWith(
      expect.objectContaining({ action: "type", text: "hello world" }),
      mockCtx
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
      mockCtx
    );
    expect(mockInputExecute).toHaveBeenCalledWith(
      expect.objectContaining({ action: "hotkey", key: "c", modifiers: ["ctrl"] }),
      mockCtx
    );
  });

  it("should route to desktop script execution", async () => {
    await computerUseTool.execute(
      {
        task: "run a script on the desktop",
        environment: "desktop",
        script: "tell app Finder to activate",
        scriptType: "applescript",
      },
      mockCtx
    );
    expect(mockScriptExecute).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "applescript",
        script: "tell app Finder to activate",
      }),
      mockCtx
    );
  });

  it("should use 'shell' as default script type", async () => {
    await computerUseTool.execute(
      {
        task: "run script",
        environment: "desktop",
        script: "echo hello",
      },
      mockCtx
    );
    expect(mockScriptExecute).toHaveBeenCalledWith(
      expect.objectContaining({ type: "shell" }),
      mockCtx
    );
  });

  it("should pass explicit inputAction through", async () => {
    await computerUseTool.execute(
      {
        task: "scroll down",
        environment: "desktop",
        inputAction: "scroll",
      },
      mockCtx
    );
    expect(mockInputExecute).toHaveBeenCalledWith(
      expect.objectContaining({ action: "scroll" }),
      mockCtx
    );
  });

  // ── CLI routing ─────────────────────────────────────────────────────────────

  it("should route to bash for CLI tasks", async () => {
    await computerUseTool.execute(
      { task: "run a shell command", environment: "cli", command: "echo hello" },
      mockCtx
    );
    expect(mockBashExecute).toHaveBeenCalledWith(
      expect.objectContaining({ command: "echo hello" }),
      mockCtx
    );
  });

  it("should return error when CLI task has no command", async () => {
    const result = await computerUseTool.execute(
      { task: "run a command", environment: "cli" },
      mockCtx
    );
    expect(result.ok).toBe(false);
    expect(result.content).toContain("command is required");
  });

  // ── Composite task decomposition ────────────────────────────────────────────

  it("should decompose 'open URL and take screenshot'", async () => {
    const result = await computerUseTool.execute(
      { task: "navigate to https://example.com and take a screenshot" },
      mockCtx
    );
    expect(result.ok).toBe(true);
    expect(mockBrowserExecute).toHaveBeenCalledTimes(2);
    // First call: navigate
    expect(mockBrowserExecute.mock.calls[0][0]).toEqual(
      expect.objectContaining({ action: "navigate", url: "https://example.com" })
    );
    // Second call: screenshot
    expect(mockBrowserExecute.mock.calls[1][0]).toEqual(
      expect.objectContaining({ action: "screenshot" })
    );
  });

  it("should decompose 'open URL and click selector'", async () => {
    const result = await computerUseTool.execute(
      { task: "go to https://app.dev and click #login-button" },
      mockCtx
    );
    expect(result.ok).toBe(true);
    expect(mockBrowserExecute).toHaveBeenCalledTimes(2);
    expect(mockBrowserExecute.mock.calls[0][0]).toEqual(
      expect.objectContaining({ action: "navigate", url: "https://app.dev" })
    );
    expect(mockBrowserExecute.mock.calls[1][0]).toEqual(
      expect.objectContaining({ action: "click", selector: "#login-button" })
    );
  });

  it("should decompose 'open URL and type into selector'", async () => {
    const result = await computerUseTool.execute(
      { task: 'navigate to https://app.dev and type "hello" into #search-input' },
      mockCtx
    );
    expect(result.ok).toBe(true);
    expect(mockBrowserExecute).toHaveBeenCalledTimes(2);
    expect(mockBrowserExecute.mock.calls[1][0]).toEqual(
      expect.objectContaining({ action: "type", text: "hello", selector: "#search-input" })
    );
  });

  it("should stop on first failure in composite task", async () => {
    mockBrowserExecute
      .mockResolvedValueOnce({ ok: true, content: "navigated" })
      .mockResolvedValueOnce({ ok: false, content: "click failed", error: { code: "EXEC_ERROR", message: "click failed", retryable: false } });

    const result = await computerUseTool.execute(
      { task: "go to https://example.com and click #missing" },
      mockCtx
    );
    expect(result.ok).toBe(false);
    expect(result.content).toContain("✓");
    expect(result.content).toContain("✗");
  });

  // ── Error handling ──────────────────────────────────────────────────────────

  it("should return error for browser task without URL or action", async () => {
    const result = await computerUseTool.execute(
      { task: "do something with the browser", environment: "browser" },
      mockCtx
    );
    expect(result.ok).toBe(false);
    expect(result.content).toContain("Could not determine browser action");
  });

  it("should return error for desktop task without sufficient info", async () => {
    const result = await computerUseTool.execute(
      { task: "do something on desktop", environment: "desktop" },
      mockCtx
    );
    expect(result.ok).toBe(false);
    expect(result.content).toContain("Could not determine desktop action");
  });

  it("should handle sub-tool execution errors gracefully", async () => {
    mockBrowserExecute.mockRejectedValueOnce(new Error("playwright not installed"));
    const result = await computerUseTool.execute(
      { task: "navigate to https://example.com", environment: "browser" },
      mockCtx
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
      mockCtx
    );
    expect(mockBrowserExecute).toHaveBeenCalledWith(
      expect.objectContaining({ action: "screenshot", path: "/tmp/cap.png" }),
      mockCtx
    );
  });

  it("should forward screenshotPath to desktop screenshot", async () => {
    await computerUseTool.execute(
      {
        task: "take a desktop screenshot",
        environment: "desktop",
        screenshotPath: "/tmp/screen.png",
      },
      mockCtx
    );
    expect(mockScreenshotExecute).toHaveBeenCalledWith(
      expect.objectContaining({ path: "/tmp/screen.png" }),
      mockCtx
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
      mockCtx
    );
    expect(mockBrowserExecute).toHaveBeenCalledWith(
      expect.objectContaining({ action: "evaluate", expression: "document.title" }),
      mockCtx
    );
  });
});
