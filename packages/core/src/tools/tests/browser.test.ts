/**
 * Tests for browser tool — Playwright integration.
 *
 * Uses vitest mocking to avoid requiring an actual browser binary.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ToolContext, ToolDef } from "../types.js";

// ── Mock Playwright ────────────────────────────────────────────────────────────

const mockPage = {
  goto: vi.fn().mockResolvedValue({ status: () => 200 }),
  title: vi.fn().mockResolvedValue("Test Page"),
  click: vi.fn().mockResolvedValue(undefined),
  fill: vi.fn().mockResolvedValue(undefined),
  screenshot: vi.fn().mockResolvedValue(Buffer.from("fake-png")),
  evaluate: vi.fn().mockResolvedValue("eval-result"),
  waitForSelector: vi.fn().mockResolvedValue({}),
  url: vi.fn().mockReturnValue("https://example.com"),
  close: vi.fn().mockResolvedValue(undefined),
};

const mockContext = {
  newPage: vi.fn().mockResolvedValue(mockPage),
  close: vi.fn().mockResolvedValue(undefined),
  cookies: vi.fn().mockResolvedValue([{ name: "session", value: "abc123" }]),
  addCookies: vi.fn().mockResolvedValue(undefined),
  pages: vi.fn().mockReturnValue([mockPage]),
};

const mockBrowser = {
  isConnected: vi.fn().mockReturnValue(true),
  newContext: vi.fn().mockResolvedValue(mockContext),
  close: vi.fn().mockResolvedValue(undefined),
  contexts: vi.fn().mockReturnValue([mockContext]),
};

const mockChromium = {
  launch: vi.fn().mockResolvedValue(mockBrowser),
  connectOverCDP: vi.fn().mockResolvedValue(mockBrowser),
};

vi.mock("playwright", () => ({
  chromium: mockChromium,
}));

vi.mock("node:fs/promises", () => ({
  writeFile: vi.fn().mockResolvedValue(undefined),
  readFile: vi.fn().mockResolvedValue("[]"),
  mkdir: vi.fn().mockResolvedValue(undefined),
}));

// ── Import after mock ──────────────────────────────────────────────────────────

import { browserTool, closeAllBrowserSessions } from "../browser.js";

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeCtx(sessionId = "test-session"): ToolContext {
  return { cwd: "/tmp", sessionId };
}

// ── Test Suite ─────────────────────────────────────────────────────────────────

describe("browser tool", () => {
  let tool: ToolDef;

  beforeEach(() => {
    vi.clearAllMocks();
    tool = browserTool;
    mockBrowser.isConnected.mockReturnValue(true);
  });

  afterEach(async () => {
    await closeAllBrowserSessions();
  });

  // ── Metadata ─────────────────────────────────────────────────────────────────

  it("should have correct tool name", () => {
    expect(tool.name).toBe("browser");
  });

  it("should require action parameter", () => {
    expect(tool.parameters.required).toContain("action");
  });

  it("should have medium risk level", () => {
    expect(tool.options?.riskLevel).toBe("medium");
  });

  // ── Navigate ─────────────────────────────────────────────────────────────────

  it("should navigate to a URL", async () => {
    const result = await tool.execute(
      { action: "navigate", url: "https://example.com" },
      makeCtx(),
    );

    expect(result.ok).toBe(true);
    expect(result.content).toContain("https://example.com");
    expect(result.content).toContain("status: 200");
    expect(result.content).toContain("Test Page");
    expect(mockPage.goto).toHaveBeenCalledWith("https://example.com", {
      timeout: 30_000,
      waitUntil: "load",
    });
  });

  it("should error when navigate has no url", async () => {
    const result = await tool.execute({ action: "navigate" }, makeCtx());
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain("url is required");
  });

  it("should support custom waitUntil option", async () => {
    await tool.execute(
      { action: "navigate", url: "https://example.com", waitUntil: "networkidle" },
      makeCtx(),
    );
    expect(mockPage.goto).toHaveBeenCalledWith("https://example.com", {
      timeout: 30_000,
      waitUntil: "networkidle",
    });
  });

  it("should handle navigate with null response (status 0)", async () => {
    const noResponsePage = {
      ...mockPage,
      goto: vi.fn().mockResolvedValue(null),
      title: vi.fn().mockResolvedValue("No Resp Page"),
    };
    mockContext.newPage.mockResolvedValueOnce(noResponsePage);

    const result = await tool.execute(
      { action: "navigate", url: "https://example.com" },
      makeCtx("null-resp"),
    );

    expect(result.ok).toBe(true);
    expect(result.content).toContain("status: 0");
  });

  // ── Click ────────────────────────────────────────────────────────────────────

  it("should click an element by selector", async () => {
    const result = await tool.execute(
      { action: "click", selector: "button#submit" },
      makeCtx(),
    );

    expect(result.ok).toBe(true);
    expect(result.content).toContain("button#submit");
    expect(mockPage.click).toHaveBeenCalledWith("button#submit", {
      timeout: 30_000,
    });
  });

  it("should error when click has no selector", async () => {
    const result = await tool.execute({ action: "click" }, makeCtx());
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain("selector is required");
  });

  // ── Type ─────────────────────────────────────────────────────────────────────

  it("should type text into an element", async () => {
    const result = await tool.execute(
      { action: "type", selector: "input[name=email]", text: "test@example.com" },
      makeCtx(),
    );

    expect(result.ok).toBe(true);
    expect(result.content).toContain("test@example.com");
    expect(mockPage.fill).toHaveBeenCalledWith(
      "input[name=email]",
      "test@example.com",
      { timeout: 30_000 },
    );
  });

  it("should error when type has no text", async () => {
    const result = await tool.execute(
      { action: "type", selector: "input" },
      makeCtx(),
    );
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain("text is required");
  });

  it("should error when type has no selector", async () => {
    const result = await tool.execute(
      { action: "type", text: "hello" },
      makeCtx(),
    );
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain("selector is required");
  });

  // ── Screenshot ───────────────────────────────────────────────────────────────

  it("should take a screenshot", async () => {
    const result = await tool.execute({ action: "screenshot" }, makeCtx());

    expect(result.ok).toBe(true);
    expect(result.content).toContain("Screenshot captured");
    expect(mockPage.screenshot).toHaveBeenCalledWith({
      fullPage: false,
    });
  });

  it("should save screenshot to file path", async () => {
    const result = await tool.execute(
      { action: "screenshot", path: "/tmp/test.png" },
      makeCtx(),
    );

    expect(result.ok).toBe(true);
    expect(result.content).toContain("/tmp/test.png");
    expect(mockPage.screenshot).toHaveBeenCalledWith({
      fullPage: false,
      path: "/tmp/test.png",
    });
  });

  it("should support full page screenshot", async () => {
    await tool.execute({ action: "screenshot", fullPage: true }, makeCtx());

    expect(mockPage.screenshot).toHaveBeenCalledWith({
      fullPage: true,
    });
  });

  // ── Evaluate ─────────────────────────────────────────────────────────────────

  it("should evaluate JavaScript expression", async () => {
    mockPage.evaluate.mockResolvedValueOnce(42);
    const result = await tool.execute(
      { action: "evaluate", expression: "document.title" },
      makeCtx(),
    );

    expect(result.ok).toBe(true);
    expect(result.content).toBe("42");
  });

  it("should error when evaluate has no expression", async () => {
    const result = await tool.execute({ action: "evaluate" }, makeCtx());
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain("expression is required");
  });

  it("should return string result directly without JSON serialization", async () => {
    mockPage.evaluate.mockResolvedValueOnce("plain string result");
    const result = await tool.execute(
      { action: "evaluate", expression: "document.title" },
      makeCtx(),
    );

    expect(result.ok).toBe(true);
    expect(result.content).toBe("plain string result");
  });

  it("should handle undefined evaluate result", async () => {
    mockPage.evaluate.mockResolvedValueOnce(undefined);
    const result = await tool.execute(
      { action: "evaluate", expression: "void 0" },
      makeCtx(),
    );

    expect(result.ok).toBe(true);
    expect(result.content).toBe("(undefined)");
  });

  // ── WaitForSelector ──────────────────────────────────────────────────────────

  it("should wait for selector to appear", async () => {
    const result = await tool.execute(
      { action: "waitForSelector", selector: ".loaded" },
      makeCtx(),
    );

    expect(result.ok).toBe(true);
    expect(result.content).toContain(".loaded");
    expect(mockPage.waitForSelector).toHaveBeenCalledWith(".loaded", {
      timeout: 30_000,
    });
  });

  it("should error when waitForSelector has no selector", async () => {
    const result = await tool.execute(
      { action: "waitForSelector" },
      makeCtx(),
    );
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain("selector is required");
  });

  // ── Close ────────────────────────────────────────────────────────────────────

  it("should close browser session", async () => {
    // First create a session
    await tool.execute(
      { action: "navigate", url: "https://example.com" },
      makeCtx("close-test"),
    );

    const result = await tool.execute({ action: "close" }, makeCtx("close-test"));
    expect(result.ok).toBe(true);
    expect(result.content).toContain("closed");
    expect(mockBrowser.close).toHaveBeenCalled();
  });

  it("should handle close with no active session gracefully", async () => {
    const result = await tool.execute(
      { action: "close" },
      makeCtx("no-session-close"),
    );
    expect(result.ok).toBe(true);
    expect(result.content).toContain("closed");
  });

  it("should handle close errors silently", async () => {
    await tool.execute(
      { action: "navigate", url: "https://example.com" },
      makeCtx("close-error"),
    );
    mockBrowser.close.mockRejectedValueOnce(new Error("Already closed"));

    // Should not throw — the error is caught internally by catch(() => {})
    const result = await tool.execute(
      { action: "close" },
      makeCtx("close-error"),
    );
    expect(result.ok).toBe(true);
    expect(result.content).toContain("closed");
  });

  // ── Unknown Action ───────────────────────────────────────────────────────────

  it("should error on unknown action", async () => {
    const result = await tool.execute(
      { action: "unknown" as any },
      makeCtx(),
    );
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain("Unknown action");
  });

  // ── General Action Error Handling ────────────────────────────────────────────

  it("should catch unexpected errors during action execution", async () => {
    mockPage.click.mockRejectedValueOnce(new Error("Element not interactable"));
    const result = await tool.execute(
      { action: "click", selector: "#disabled-btn" },
      makeCtx("gen-error"),
    );

    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain("Browser action failed");
    expect(result.error?.message).toContain("Element not interactable");
  });

  // ── Browser Launch Failure ───────────────────────────────────────────────────

  it("should handle browser launch failure", async () => {
    mockChromium.launch.mockRejectedValueOnce(new Error("Executable not found"));
    const result = await tool.execute(
      { action: "navigate", url: "https://example.com" },
      makeCtx("launch-fail"),
    );

    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain("Failed to launch browser");
    expect(result.error?.message).toContain("Executable not found");
  });

  // ── Session Reuse ────────────────────────────────────────────────────────────

  it("should reuse existing connected session", async () => {
    // First navigate creates a session
    await tool.execute(
      { action: "navigate", url: "https://example.com" },
      makeCtx("reuse-test"),
    );

    // Clear mocks to track new calls
    mockChromium.launch.mockClear();
    mockBrowser.newContext.mockClear();
    mockContext.newPage.mockClear();

    // Second navigate with same sessionId should reuse the session
    const result = await tool.execute(
      { action: "navigate", url: "https://google.com" },
      makeCtx("reuse-test"),
    );

    expect(result.ok).toBe(true);
    // Should not create a new browser or context since session is reused
    expect(mockChromium.launch).not.toHaveBeenCalled();
    expect(mockBrowser.newContext).not.toHaveBeenCalled();
  });

  // ── Custom Viewport ──────────────────────────────────────────────────────────

  it("should support custom viewport size", async () => {
    await tool.execute(
      { action: "navigate", url: "https://example.com", width: 800, height: 600 },
      makeCtx("viewport-test"),
    );

    expect(mockChromium.launch).toHaveBeenCalledWith({ headless: true });
    expect(mockBrowser.newContext).toHaveBeenCalledWith({
      viewport: { width: 800, height: 600 },
    });
  });

  it("should use default viewport when not specified", async () => {
    await tool.execute(
      { action: "navigate", url: "https://example.com" },
      makeCtx("default-vp"),
    );

    expect(mockBrowser.newContext).toHaveBeenCalledWith({
      viewport: { width: 1280, height: 720 },
    });
  });

  // ── Headed Mode ──────────────────────────────────────────────────────────────

  it("should support headed mode", async () => {
    await tool.execute(
      { action: "navigate", url: "https://example.com", headed: true },
      makeCtx("headed-test"),
    );

    expect(mockChromium.launch).toHaveBeenCalledWith({ headless: false });
  });

  // ── CDP Connect ─────────────────────────────────────────────────────────────

  it("should connect to Chrome via CDP", async () => {
    const result = await tool.execute(
      { action: "connect", cdpUrl: "http://localhost:9222" },
      makeCtx("cdp-test"),
    );

    expect(result.ok).toBe(true);
    expect(result.content).toContain("CDP");
    expect(result.content).toContain("localhost:9222");
    expect(mockChromium.connectOverCDP).toHaveBeenCalledWith("http://localhost:9222");
  });

  it("should error when connect has no cdpUrl", async () => {
    const result = await tool.execute({ action: "connect" }, makeCtx());
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain("cdpUrl is required");
  });

  it("should close existing session when connecting via CDP (replaces old session)", async () => {
    // Create a normal session first
    await tool.execute(
      { action: "navigate", url: "https://example.com" },
      makeCtx("cdp-replace"),
    );

    // Reset browser.close call count from initial setup
    mockBrowser.close.mockClear();

    // Now connect via CDP — should close existing browser first
    const result = await tool.execute(
      { action: "connect", cdpUrl: "http://localhost:9222" },
      makeCtx("cdp-replace"),
    );

    expect(result.ok).toBe(true);
    expect(result.content).toContain("CDP");
    // The existing browser should have been closed
    expect(mockBrowser.close).toHaveBeenCalled();
  });

  it("should handle CDP connect failure", async () => {
    mockChromium.connectOverCDP.mockRejectedValueOnce(
      new Error("Connection refused"),
    );
    const result = await tool.execute(
      { action: "connect", cdpUrl: "http://localhost:9222" },
      makeCtx("cdp-fail"),
    );

    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain("CDP connect failed");
    expect(result.error?.message).toContain("Connection refused");
  });

  it("should create new context when CDP browser has no existing contexts", async () => {
    // Simulate CDP-returned browser with no contexts
    const browserWithNoContexts = {
      ...mockBrowser,
      contexts: vi.fn().mockReturnValue([]),
    };
    mockChromium.connectOverCDP.mockResolvedValueOnce(browserWithNoContexts);

    const result = await tool.execute(
      { action: "connect", cdpUrl: "http://localhost:9222" },
      makeCtx("cdp-no-ctx"),
    );

    expect(result.ok).toBe(true);
    expect(mockBrowser.newContext).toHaveBeenCalled();
  });

  it("should create new page when CDP context has no pages", async () => {
    // Simulate CDP-returned context with no pages
    mockContext.pages.mockReturnValueOnce([]);

    const result = await tool.execute(
      { action: "connect", cdpUrl: "http://localhost:9222" },
      makeCtx("cdp-no-page"),
    );

    expect(result.ok).toBe(true);
    expect(mockContext.newPage).toHaveBeenCalled();
  });

  it("should handle close error when replacing session during CDP connect", async () => {
    // Create a normal session first
    await tool.execute(
      { action: "navigate", url: "https://example.com" },
      makeCtx("cdp-close-err"),
    );

    // Make the old browser's close reject — the catch should swallow it
    mockBrowser.close.mockRejectedValueOnce(new Error("Already closed"));

    const result = await tool.execute(
      { action: "connect", cdpUrl: "http://localhost:9222" },
      makeCtx("cdp-close-err"),
    );

    expect(result.ok).toBe(true);
    expect(result.content).toContain("CDP");
  });

  // ── CDP Disconnect ───────────────────────────────────────────────────────────

  it("should disconnect from CDP session", async () => {
    // First connect
    await tool.execute(
      { action: "connect", cdpUrl: "http://localhost:9222" },
      makeCtx("cdp-disconnect"),
    );

    const result = await tool.execute(
      { action: "disconnect" },
      makeCtx("cdp-disconnect"),
    );

    expect(result.ok).toBe(true);
    expect(result.content).toContain("Disconnected");
  });

  it("should error when disconnect has no active session", async () => {
    const result = await tool.execute(
      { action: "disconnect" },
      makeCtx("no-session"),
    );
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain("No active browser session");
  });

  it("should error when disconnecting a non-CDP session", async () => {
    // Create a normal session via navigate (not CDP)
    await tool.execute(
      { action: "navigate", url: "https://example.com" },
      makeCtx("non-cdp"),
    );

    const result = await tool.execute(
      { action: "disconnect" },
      makeCtx("non-cdp"),
    );

    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain("not a CDP session");
  });

  // ── Tab Management ──────────────────────────────────────────────────────────

  it("should open a new tab", async () => {
    // Create a session first
    await tool.execute(
      { action: "navigate", url: "https://example.com" },
      makeCtx("newtab-test"),
    );

    mockContext.newPage.mockResolvedValueOnce({
      ...mockPage,
      title: vi.fn().mockResolvedValue("New Tab"),
      url: vi.fn().mockReturnValue("about:blank"),
    });

    const result = await tool.execute(
      { action: "newTab", url: "https://google.com" },
      makeCtx("newtab-test"),
    );

    expect(result.ok).toBe(true);
    expect(result.content).toContain("New tab opened");
  });

  it("should open a new tab without URL", async () => {
    await tool.execute(
      { action: "navigate", url: "https://example.com" },
      makeCtx("newtab-nourl"),
    );

    const result = await tool.execute(
      { action: "newTab" },
      makeCtx("newtab-nourl"),
    );

    expect(result.ok).toBe(true);
    expect(result.content).toContain("New tab opened");
    expect(result.content).not.toContain("navigated to");
    // goto should NOT have been called for the new tab
    const gotoCalls = mockPage.goto.mock.calls.filter(
      (call: unknown[]) => (call[0] as string) !== "https://example.com",
    );
    expect(gotoCalls).toHaveLength(0);
  });

  it("should list tabs", async () => {
    await tool.execute(
      { action: "navigate", url: "https://example.com" },
      makeCtx("listtabs-test"),
    );

    const result = await tool.execute(
      { action: "listTabs" },
      makeCtx("listtabs-test"),
    );

    expect(result.ok).toBe(true);
    expect(result.content).toContain("Test Page");
    expect(result.content).toContain("active");
  });

  it("should handle tab title fetch errors gracefully in listTabs", async () => {
    await tool.execute(
      { action: "navigate", url: "https://example.com" },
      makeCtx("title-err"),
    );

    mockPage.title.mockRejectedValueOnce(new Error("Title not available"));

    const result = await tool.execute(
      { action: "listTabs" },
      makeCtx("title-err"),
    );

    expect(result.ok).toBe(true);
    expect(result.content).toContain("(untitled)");
  });

  it("should error when switchTab has no tabIndex", async () => {
    await tool.execute(
      { action: "navigate", url: "https://example.com" },
      makeCtx("notab-test"),
    );

    const result = await tool.execute(
      { action: "switchTab" },
      makeCtx("notab-test"),
    );

    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain("tabIndex is required");
  });

  it("should error on out-of-range tabIndex", async () => {
    await tool.execute(
      { action: "navigate", url: "https://example.com" },
      makeCtx("oor-test"),
    );

    const result = await tool.execute(
      { action: "switchTab", tabIndex: 99 },
      makeCtx("oor-test"),
    );

    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain("out of range");
  });

  it("should switch to a valid tab by index", async () => {
    // Create session with first tab
    await tool.execute(
      { action: "navigate", url: "https://example.com" },
      makeCtx("switch-ok"),
    );
    // Add a second tab
    await tool.execute(
      { action: "newTab", url: "https://google.com" },
      makeCtx("switch-ok"),
    );

    // Switch back to tab 0
    mockPage.title.mockResolvedValueOnce("Example Domain");
    const result = await tool.execute(
      { action: "switchTab", tabIndex: 0 },
      makeCtx("switch-ok"),
    );

    expect(result.ok).toBe(true);
    expect(result.content).toContain("Switched to tab 0");
    expect(result.content).toContain("Example Domain");
  });

  // ── Close Tab ────────────────────────────────────────────────────────────────

  it("should close a tab", async () => {
    await tool.execute(
      { action: "navigate", url: "https://example.com" },
      makeCtx("close-tab-ok"),
    );
    // Add another tab so we have more than 1
    await tool.execute(
      { action: "newTab", url: "https://google.com" },
      makeCtx("close-tab-ok"),
    );

    const result = await tool.execute(
      { action: "closeTab", tabIndex: 1 },
      makeCtx("close-tab-ok"),
    );

    expect(result.ok).toBe(true);
    expect(result.content).toContain("Closed tab 1");
    expect(result.content).toContain("Remaining: 1");
    expect(mockPage.close).toHaveBeenCalled();
  });

  it("should error when closeTab has no tabIndex", async () => {
    await tool.execute(
      { action: "navigate", url: "https://example.com" },
      makeCtx("close-notab"),
    );

    const result = await tool.execute(
      { action: "closeTab" },
      makeCtx("close-notab"),
    );

    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain("tabIndex is required");
  });

  it("should error on out-of-range closeTab index", async () => {
    await tool.execute(
      { action: "navigate", url: "https://example.com" },
      makeCtx("close-oor"),
    );

    const result = await tool.execute(
      { action: "closeTab", tabIndex: 99 },
      makeCtx("close-oor"),
    );

    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain("out of range");
  });

  it("should error when closing the last tab", async () => {
    await tool.execute(
      { action: "navigate", url: "https://example.com" },
      makeCtx("close-last"),
    );

    const result = await tool.execute(
      { action: "closeTab", tabIndex: 0 },
      makeCtx("close-last"),
    );

    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain("Cannot close the last tab");
  });

  it("should adjust activePageIndex when closing a tab before the active one", async () => {
    // Create 3 tabs: navigate (idx 0), newTab (idx 1), newTab (idx 2, active)
    await tool.execute(
      { action: "navigate", url: "https://example.com" },
      makeCtx("active-adjust"),
    );
    await tool.execute(
      { action: "newTab", url: "https://google.com" },
      makeCtx("active-adjust"),
    );
    await tool.execute(
      { action: "newTab", url: "https://bing.com" },
      makeCtx("active-adjust"),
    );
    // Active tab is now index 2 (the last one created)

    // Close tab 2 — active should shift to tab 1
    const closeResult = await tool.execute(
      { action: "closeTab", tabIndex: 2 },
      makeCtx("active-adjust"),
    );
    expect(closeResult.ok).toBe(true);

    // Now list tabs to verify active is at index 1
    mockPage.title.mockResolvedValue("Example Domain");
    mockPage.url.mockReturnValue("https://example.com");
    const listResult = await tool.execute(
      { action: "listTabs" },
      makeCtx("active-adjust"),
    );
    const tabs = JSON.parse(listResult.content);
    // The active tab should now be index 1 (was 2, adjusted down)
    const activeTab = tabs.find((t: any) => t.active);
    expect(activeTab).toBeDefined();
    expect(activeTab.index).toBe(1);
  });

  // ── Cookie Persistence ──────────────────────────────────────────────────────

  it("should save cookies to file", async () => {
    const { writeFile } = await import("node:fs/promises");
    await tool.execute(
      { action: "navigate", url: "https://example.com" },
      makeCtx("save-cookies"),
    );

    const result = await tool.execute(
      { action: "saveCookies", sessionPath: "/tmp/cookies.json" },
      makeCtx("save-cookies"),
    );

    expect(result.ok).toBe(true);
    expect(result.content).toContain("Saved");
    expect(writeFile).toHaveBeenCalled();
  });

  it("should load cookies from file", async () => {
    const { readFile } = await import("node:fs/promises");
    (readFile as any).mockResolvedValueOnce(
      JSON.stringify([{ name: "token", value: "xyz" }])
    );

    await tool.execute(
      { action: "navigate", url: "https://example.com" },
      makeCtx("load-cookies"),
    );

    const result = await tool.execute(
      { action: "loadCookies", sessionPath: "/tmp/cookies.json" },
      makeCtx("load-cookies"),
    );

    expect(result.ok).toBe(true);
    expect(result.content).toContain("Loaded");
    expect(mockContext.addCookies).toHaveBeenCalled();
  });

  it("should error when saveCookies has no sessionPath", async () => {
    await tool.execute(
      { action: "navigate", url: "https://example.com" },
      makeCtx("no-path-cookies"),
    );

    const result = await tool.execute(
      { action: "saveCookies" },
      makeCtx("no-path-cookies"),
    );

    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain("sessionPath is required");
  });

  it("should error when loadCookies has no sessionPath", async () => {
    await tool.execute(
      { action: "navigate", url: "https://example.com" },
      makeCtx("load-cookie-no-path"),
    );

    const result = await tool.execute(
      { action: "loadCookies" },
      makeCtx("load-cookie-no-path"),
    );

    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain("sessionPath is required");
  });

  // ── Session Persistence ─────────────────────────────────────────────────────

  it("should save full session to file", async () => {
    const { writeFile } = await import("node:fs/promises");
    await tool.execute(
      { action: "navigate", url: "https://example.com" },
      makeCtx("save-session"),
    );

    const result = await tool.execute(
      { action: "saveSession", sessionPath: "/tmp/session.json" },
      makeCtx("save-session"),
    );

    expect(result.ok).toBe(true);
    expect(result.content).toContain("Session saved");
    expect(writeFile).toHaveBeenCalled();
  });

  it("should load session from file", async () => {
    const { readFile } = await import("node:fs/promises");
    (readFile as any).mockResolvedValueOnce(
      JSON.stringify({
        cookies: [{ name: "s", value: "v" }],
        tabs: ["https://a.com", "https://b.com"],
        activeTab: 1,
      })
    );

    await tool.execute(
      { action: "navigate", url: "https://example.com" },
      makeCtx("load-session"),
    );

    const result = await tool.execute(
      { action: "loadSession", sessionPath: "/tmp/session.json" },
      makeCtx("load-session"),
    );

    expect(result.ok).toBe(true);
    expect(result.content).toContain("Session loaded");
  });

  it("should error when saveSession has no sessionPath", async () => {
    await tool.execute(
      { action: "navigate", url: "https://example.com" },
      makeCtx("no-path-session"),
    );

    const result = await tool.execute(
      { action: "saveSession" },
      makeCtx("no-path-session"),
    );

    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain("sessionPath is required");
  });

  it("should error when loadSession has no sessionPath", async () => {
    await tool.execute(
      { action: "navigate", url: "https://example.com" },
      makeCtx("no-path-load-session"),
    );

    const result = await tool.execute(
      { action: "loadSession" },
      makeCtx("no-path-load-session"),
    );

    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain("sessionPath is required");
  });

  it("should load session with only cookies (no tabs)", async () => {
    const { readFile } = await import("node:fs/promises");
    (readFile as any).mockResolvedValueOnce(
      JSON.stringify({
        cookies: [{ name: "token", value: "abc" }],
      })
    );

    await tool.execute(
      { action: "navigate", url: "https://example.com" },
      makeCtx("load-cookies-only"),
    );

    const result = await tool.execute(
      { action: "loadSession", sessionPath: "/tmp/cookies-only.json" },
      makeCtx("load-cookies-only"),
    );

    expect(result.ok).toBe(true);
    expect(result.content).toContain("Session loaded");
    expect(mockContext.addCookies).toHaveBeenCalled();
  });

  it("should load session with only tabs (no cookies)", async () => {
    const { readFile } = await import("node:fs/promises");
    (readFile as any).mockResolvedValueOnce(
      JSON.stringify({
        tabs: ["https://a.com", "https://b.com"],
        activeTab: 0,
      })
    );

    await tool.execute(
      { action: "navigate", url: "https://example.com" },
      makeCtx("load-tabs-only"),
    );

    const result = await tool.execute(
      { action: "loadSession", sessionPath: "/tmp/tabs-only.json" },
      makeCtx("load-tabs-only"),
    );

    expect(result.ok).toBe(true);
    expect(result.content).toContain("Session loaded");
    // Should have opened a new page for the second tab URL
    expect(mockContext.newPage).toHaveBeenCalled();
  });

  it("should handle loading an empty session file", async () => {
    const { readFile } = await import("node:fs/promises");
    (readFile as any).mockResolvedValueOnce(JSON.stringify({}));

    await tool.execute(
      { action: "navigate", url: "https://example.com" },
      makeCtx("load-empty"),
    );

    const result = await tool.execute(
      { action: "loadSession", sessionPath: "/tmp/empty.json" },
      makeCtx("load-empty"),
    );

    expect(result.ok).toBe(true);
    expect(result.content).toContain("Session loaded");
  });

  it("should close extra tabs when restoring session with fewer tabs", async () => {
    // Create a session with 3 pages to ensure the close loop executes
    await tool.execute(
      { action: "navigate", url: "https://example.com" },
      makeCtx("load-close-loop"),
    );
    await tool.execute(
      { action: "newTab", url: "https://google.com" },
      makeCtx("load-close-loop"),
    );
    await tool.execute(
      { action: "newTab", url: "https://bing.com" },
      makeCtx("load-close-loop"),
    );

    const { readFile } = await import("node:fs/promises");
    (readFile as any).mockResolvedValueOnce(
      JSON.stringify({
        cookies: [{ name: "s", value: "v" }],
        tabs: ["https://a.com"],
        activeTab: 0,
      })
    );

    mockPage.close.mockClear();

    const result = await tool.execute(
      { action: "loadSession", sessionPath: "/tmp/restore.json" },
      makeCtx("load-close-loop"),
    );

    expect(result.ok).toBe(true);
    // The for loop should have closed tabs at index 2 and 1 (keeping tab 0)
    expect(mockPage.close).toHaveBeenCalledTimes(2);
  });

  // ── CloseAllBrowserSessions ─────────────────────────────────────────────────

  it("closeAllBrowserSessions should close all active sessions", async () => {
    // Create two sessions
    await tool.execute(
      { action: "navigate", url: "https://example.com" },
      makeCtx("all-1"),
    );
    await tool.execute(
      { action: "navigate", url: "https://google.com" },
      makeCtx("all-2"),
    );

    mockBrowser.close.mockClear();
    await closeAllBrowserSessions();

    // Both sessions' browsers should be closed
    expect(mockBrowser.close).toHaveBeenCalledTimes(2);
  });
});

// ── Edge case: playwright not installed ────────────────────────────────────────
// This test uses vi.resetModules + vi.doMock to simulate a missing playwright
// module. It must be in its own describe block so the fresh dynamic imports
// don't interfere with the statically-imported module used by other tests.

describe("browser tool - playwright not installed", () => {
  it("should error when playwright is not installed", async () => {
    vi.resetModules();
    vi.doMock("playwright", () => {
      throw new Error("Cannot find module 'playwright'");
    });
    vi.doMock("node:fs/promises", () => ({
      writeFile: vi.fn().mockResolvedValue(undefined),
      readFile: vi.fn().mockResolvedValue("[]"),
      mkdir: vi.fn().mockResolvedValue(undefined),
    }));

    const { browserTool: bt } = await import("../browser.js");

    const result = await bt.execute(
      { action: "navigate", url: "https://example.com" },
      { cwd: "/tmp", sessionId: "no-pw" },
    );

    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain("playwright is not installed");
  });
});
