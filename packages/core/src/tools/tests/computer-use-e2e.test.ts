/**
 * CU14: Computer Use E2E tests
 *
 * End-to-end tests that verify the complete flow of the computer_use
 * meta-tool from task description → environment detection → sub-tool
 * routing → result aggregation. Tests realistic multi-step scenarios
 * without mocking the computer-use module itself.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ToolContext, ToolResult, ToolDef } from "../types.js";

// ── Mock sub-tools with controllable behavior (vi.hoisted for hoisting) ─────

const {
  mockBrowserExecute,
  mockScreenshotExecute,
  mockInputExecute,
  mockScriptExecute,
  mockAccessibilityExecute,
  mockBashExecute,
  mockVisualAnalyzeExecute,
} = vi.hoisted(() => ({
  mockBrowserExecute: vi.fn(),
  mockScreenshotExecute: vi.fn(),
  mockInputExecute: vi.fn(),
  mockScriptExecute: vi.fn(),
  mockAccessibilityExecute: vi.fn(),
  mockBashExecute: vi.fn(),
  mockVisualAnalyzeExecute: vi.fn(),
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

vi.mock("../visual-analyze.js", () => ({
  createVisualAnalyzeTool: vi.fn((_adapter?: unknown, _model?: string) => ({
    name: "visual_analyze",
    description: "mock visual analyze",
    parameters: { type: "object", properties: {} },
    execute: mockVisualAnalyzeExecute,
  })),
}));

// ── Import after mock ───────────────────────────────────────────────────────

import { computerUseTool } from "../computer-use.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeCtx(overrides?: Partial<ToolContext>): ToolContext {
  return {
    cwd: "/tmp/e2e-test",
    sessionId: "e2e-session",
    ...overrides,
  };
}

function ok(content: string, metadata?: Record<string, unknown>): ToolResult {
  return { ok: true, content, metadata };
}

function fail(message: string): ToolResult {
  return { ok: false, content: message, error: { code: "EXEC_ERROR", message, retryable: false } };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("CU14: Computer Use E2E tests", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // Default: all sub-tools succeed
    mockBrowserExecute.mockResolvedValue(ok("browser action completed"));
    mockScreenshotExecute.mockResolvedValue(ok("screenshot saved to /tmp/screen.png"));
    mockInputExecute.mockResolvedValue(ok("input action completed"));
    mockScriptExecute.mockResolvedValue(ok("script executed successfully"));
    mockAccessibilityExecute.mockResolvedValue(ok("found 3 interactive elements"));
    mockBashExecute.mockResolvedValue(ok("command output"));
    mockVisualAnalyzeExecute.mockResolvedValue(ok("## Description\nA login page with username and password fields.\n\n## Suggested Actions\n1. Click #username\n2. Type credentials"));
  });

  // ── E2E 1: Browser multi-step — sequential single-action calls ──────────

  it("E2E: browser task — navigate, click, type, screenshot as sequential actions", async () => {
    // Simulate a full browser workflow via sequential single-action calls
    mockBrowserExecute
      .mockResolvedValueOnce(ok("navigated to https://app.example.com"))
      .mockResolvedValueOnce(ok("clicked #login-button"))
      .mockResolvedValueOnce(ok("typed 'user@example.com' into #email"))
      .mockResolvedValueOnce(ok("screenshot saved"));

    // Step 1: navigate
    const navResult = await computerUseTool.execute(
      { task: "navigate to the app", environment: "browser", url: "https://app.example.com" },
      makeCtx(),
    );
    expect(navResult.ok).toBe(true);
    expect(mockBrowserExecute).toHaveBeenLastCalledWith(
      expect.objectContaining({ action: "navigate", url: "https://app.example.com" }),
      expect.anything(),
    );

    // Step 2: click
    const clickResult = await computerUseTool.execute(
      { task: "click the login button", environment: "browser", action: "click", selector: "#login-button" },
      makeCtx(),
    );
    expect(clickResult.ok).toBe(true);
    expect(mockBrowserExecute).toHaveBeenLastCalledWith(
      expect.objectContaining({ action: "click", selector: "#login-button" }),
      expect.anything(),
    );

    // Step 3: type
    const typeResult = await computerUseTool.execute(
      { task: "type email", environment: "browser", action: "type", text: "user@example.com", selector: "#email" },
      makeCtx(),
    );
    expect(typeResult.ok).toBe(true);

    // Step 4: screenshot
    const ssResult = await computerUseTool.execute(
      { task: "take a screenshot", environment: "browser" },
      makeCtx(),
    );
    expect(ssResult.ok).toBe(true);
    expect(mockBrowserExecute).toHaveBeenCalledTimes(4);
  });

  // ── E2E 2: Desktop task — screenshot → analyze → click → type ──────────

  it("E2E: desktop task — screenshot, analyze, click, type text", async () => {
    const mockAdapter = { complete: vi.fn(), stream: vi.fn() };
    const ctx = makeCtx({ llmAdapter: mockAdapter });

    // First: take a desktop screenshot
    mockScreenshotExecute.mockResolvedValueOnce(ok("screenshot saved to /tmp/desktop.png"));
    // Then: analyze it
    mockVisualAnalyzeExecute.mockResolvedValueOnce(ok(
      "## Description\nDesktop with a Finder window open.\n\n## Suggested Actions\n1. Click at (350, 400) to select file\n2. Type filename"
    ));
    // Then: click based on analysis
    mockInputExecute
      .mockResolvedValueOnce(ok("clicked at (350, 400)"))
      .mockResolvedValueOnce(ok("typed 'report.pdf'"));

    // Execute two separate desktop commands
    const screenshotResult = await computerUseTool.execute(
      { task: "take a screenshot of the desktop and analyze it", environment: "desktop", screenshotPath: "/tmp/desktop.png" },
      ctx,
    );
    expect(screenshotResult.ok).toBe(true);
    expect(mockScreenshotExecute).toHaveBeenCalledOnce();
    expect(mockVisualAnalyzeExecute).toHaveBeenCalledOnce();

    // Now use the analysis to interact
    const clickResult = await computerUseTool.execute(
      { task: "click at position on the desktop", environment: "desktop", x: 350, y: 400 },
      ctx,
    );
    expect(clickResult.ok).toBe(true);
    expect(mockInputExecute).toHaveBeenCalledWith(
      expect.objectContaining({ action: "click", x: 350, y: 400 }),
      ctx,
    );

    const typeResult = await computerUseTool.execute(
      { task: "type text on the desktop", environment: "desktop", text: "report.pdf" },
      ctx,
    );
    expect(typeResult.ok).toBe(true);
    expect(mockInputExecute).toHaveBeenCalledWith(
      expect.objectContaining({ action: "type", text: "report.pdf" }),
      ctx,
    );
  });

  // ── E2E 3: Composite — navigate + screenshot + visual analyze ──────────

  it("E2E: composite task — navigate, screenshot, and analyze with LLM", async () => {
    const mockAdapter = { complete: vi.fn(), stream: vi.fn() };
    const ctx = makeCtx({ llmAdapter: mockAdapter });

    mockBrowserExecute
      .mockResolvedValueOnce(ok("navigated to https://dashboard.example.com"))
      .mockResolvedValueOnce(ok("screenshot saved to /tmp/dash.png"));
    mockVisualAnalyzeExecute.mockResolvedValueOnce(ok(
      "## Description\nDashboard showing 3 charts and a data table.\n\n## Suggested Actions\n1. Click the export button\n2. Download CSV"
    ));

    const result = await computerUseTool.execute(
      {
        task: "navigate to https://dashboard.example.com and analyze the screenshot",
        screenshotPath: "/tmp/dash.png",
      },
      ctx,
    );

    expect(result.ok).toBe(true);
    // Should have: navigate + screenshot + visual_analyze
    expect(mockBrowserExecute).toHaveBeenCalledTimes(2);
    expect(mockVisualAnalyzeExecute).toHaveBeenCalledOnce();
    expect(result.content).toContain("✓");
  });

  // ── E2E 4: Orchestrator — login flow with conditional steps ────────────

  it("E2E: orchestrator login flow — navigate + fill form + submit + verify", async () => {
    mockBrowserExecute
      .mockResolvedValueOnce(ok("navigated to https://app.example.com/login"))
      .mockResolvedValueOnce(ok("filled #username"))
      .mockResolvedValueOnce(ok("filled #password"))
      .mockResolvedValueOnce(ok("clicked #submit"))
      .mockResolvedValueOnce(ok("navigated to https://app.example.com/dashboard"));

    const result = await computerUseTool.execute(
      {
        task: "login to https://app.example.com",
        text: "testuser",
      },
      makeCtx(),
    );

    // The orchestrator should have executed multiple steps
    expect(mockBrowserExecute).toHaveBeenCalled();
    expect(result.content).toContain("Multi-step orchestration");
    expect(result.content).toContain("steps");
  });

  // ── E2E 5: Error recovery — partial failure in composite task ──────────

  it("E2E: composite task stops gracefully on first failure", async () => {
    // Use exact same pattern as unit test (mockResolvedValueOnce chaining)
    mockBrowserExecute
      .mockResolvedValueOnce({ ok: true, content: "navigated" })
      .mockResolvedValueOnce({ ok: false, content: "click failed", error: { code: "EXEC_ERROR" as const, message: "click failed", retryable: false } });

    const result = await computerUseTool.execute(
      { task: "go to https://example.com and click #missing" },
      makeCtx(),
    );

    expect(result.ok).toBe(false);
    expect(result.content).toContain("✓");
    expect(result.content).toContain("✗");
  });

  // ── E2E 6: CLI task — full command execution ───────────────────────────

  it("E2E: CLI task — execute shell command and get output", async () => {
    mockBashExecute.mockResolvedValueOnce(ok("total 48\ndrwxr-xr-x  6 user staff  192 May 28 10:00 .\ndrwxr-xr-x  3 user staff   96 May 28 09:00 .."));

    const result = await computerUseTool.execute(
      { task: "list files in current directory", environment: "cli", command: "ls -la" },
      makeCtx(),
    );

    expect(result.ok).toBe(true);
    expect(result.content).toContain("total 48");
    expect(mockBashExecute).toHaveBeenCalledWith(
      expect.objectContaining({ command: "ls -la" }),
      expect.anything(),
    );
  });

  // ── E2E 7: Cross-environment — auto-detect switches correctly ──────────

  it("E2E: auto-detect routes browser URL tasks correctly", async () => {
    mockBrowserExecute.mockResolvedValueOnce(ok("navigated"));

    const result = await computerUseTool.execute(
      { task: "go to https://search.example.com and find something" },
      makeCtx(),
    );

    expect(result.ok).toBe(true);
    expect(mockBrowserExecute).toHaveBeenCalledWith(
      expect.objectContaining({ action: "navigate", url: "https://search.example.com" }),
      expect.anything(),
    );
    // Desktop and CLI should NOT have been called
    expect(mockInputExecute).not.toHaveBeenCalled();
    expect(mockBashExecute).not.toHaveBeenCalled();
  });

  // ── E2E 8: Desktop hotkey + script sequence ────────────────────────────

  it("E2E: desktop — hotkey then script execution", async () => {
    mockInputExecute.mockResolvedValueOnce(ok("hotkey cmd+space pressed"));
    mockScriptExecute.mockResolvedValueOnce(ok("Spotlight activated"));

    // Step 1: hotkey
    const hotkeyResult = await computerUseTool.execute(
      { task: "press hotkey to open spotlight", environment: "desktop", key: "space", modifiers: ["cmd"] },
      makeCtx(),
    );
    expect(hotkeyResult.ok).toBe(true);
    expect(mockInputExecute).toHaveBeenCalledWith(
      expect.objectContaining({ action: "hotkey", key: "space", modifiers: ["cmd"] }),
      expect.anything(),
    );

    // Step 2: script
    const scriptResult = await computerUseTool.execute(
      {
        task: "run AppleScript to type in Spotlight",
        environment: "desktop",
        script: 'tell application "System Events" to keystroke "Terminal"',
        scriptType: "applescript",
      },
      makeCtx(),
    );
    expect(scriptResult.ok).toBe(true);
    expect(mockScriptExecute).toHaveBeenCalledWith(
      expect.objectContaining({ type: "applescript", script: 'tell application "System Events" to keystroke "Terminal"' }),
      expect.anything(),
    );
  });

  // ── E2E 9: Browser with explicit action (evaluate) ─────────────────────

  it("E2E: browser — evaluate JavaScript on page", async () => {
    mockBrowserExecute.mockImplementation(async (args: Record<string, unknown>) => {
      if (args.action === "evaluate") return ok("Page Title: Example Domain");
      return ok("default browser result");
    });

    const result = await computerUseTool.execute(
      {
        task: "get the page title",
        environment: "browser",
        action: "evaluate",
        expression: "document.title",
      },
      makeCtx(),
    );

    expect(result.ok).toBe(true);
    expect(result.content).toContain("Page Title");
    expect(mockBrowserExecute).toHaveBeenCalledWith(
      expect.objectContaining({ action: "evaluate", expression: "document.title" }),
      expect.anything(),
    );
  });

  // ── E2E 10: Timeout propagation through meta-tool ─────────────────────

  it("E2E: timeout is propagated to sub-tools correctly", async () => {
    mockBrowserExecute.mockResolvedValueOnce(ok("done"));

    await computerUseTool.execute(
      { task: "navigate to https://slow.example.com", timeout: 30_000 },
      makeCtx(),
    );

    expect(mockBrowserExecute).toHaveBeenCalledWith(
      expect.objectContaining({ timeout: 30_000 }),
      expect.anything(),
    );
  });

  // ── E2E 11: Desktop multi-action workflow ───────────────────────────────

  it("E2E: desktop — screenshot, click, type, script sequence", async () => {
    mockScreenshotExecute.mockResolvedValueOnce(ok("fullscreen screenshot saved"));
    mockInputExecute
      .mockResolvedValueOnce(ok("clicked at (200, 300)"))
      .mockResolvedValueOnce(ok("typed 'hello world'"));
    mockScriptExecute.mockResolvedValueOnce(ok("applescript executed"));

    // Step 1: screenshot
    const ssResult = await computerUseTool.execute(
      { task: "take a desktop screenshot", environment: "desktop" },
      makeCtx(),
    );
    expect(ssResult.ok).toBe(true);
    expect(mockScreenshotExecute).toHaveBeenCalledOnce();

    // Step 2: click
    const clickResult = await computerUseTool.execute(
      { task: "click at position on desktop", environment: "desktop", x: 200, y: 300 },
      makeCtx(),
    );
    expect(clickResult.ok).toBe(true);
    expect(mockInputExecute).toHaveBeenCalledWith(
      expect.objectContaining({ action: "click", x: 200, y: 300 }),
      expect.anything(),
    );

    // Step 3: type
    const typeResult = await computerUseTool.execute(
      { task: "type text on desktop", environment: "desktop", text: "hello world" },
      makeCtx(),
    );
    expect(typeResult.ok).toBe(true);

    // Step 4: script
    const scriptResult = await computerUseTool.execute(
      {
        task: "run script on desktop",
        environment: "desktop",
        script: 'tell app "Finder" to activate',
        scriptType: "applescript",
      },
      makeCtx(),
    );
    expect(scriptResult.ok).toBe(true);
    expect(mockScriptExecute).toHaveBeenCalledWith(
      expect.objectContaining({ type: "applescript" }),
      expect.anything(),
    );
  });
});
