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

  // ── Unknown Action ───────────────────────────────────────────────────────────

  it("should error on unknown action", async () => {
    const result = await tool.execute(
      { action: "unknown" as any },
      makeCtx(),
    );
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain("Unknown action");
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
});
