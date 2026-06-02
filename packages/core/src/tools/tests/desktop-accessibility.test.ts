/**
 * Tests for desktop-accessibility tool — Accessibility API inspection.
 *
 * Mock approach: mock node:child_process and node:util so that the
 * promisified execFileAsync resolves/rejects under test control.
 * Tests cover all platform/action combinations, every error branch,
 * parameter validation, metadata, and edge cases.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ToolContext, ToolDef } from "../types.js";

// ── Mock state ─────────────────────────────────────────────────────────────────

const execFileAsyncMock = vi.fn();

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

vi.mock("node:util", async () => {
  const actual = await vi.importActual<typeof import("node:util")>("node:util");
  return {
    ...actual,
    promisify: vi.fn(() => execFileAsyncMock),
  };
});

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeCtx(sessionId = "test-session"): ToolContext {
  return { cwd: "/tmp", sessionId };
}

function setPlatform(platform: string) {
  Object.defineProperty(process, "platform", {
    value: platform,
    writable: true,
    configurable: true,
  });
}

// ── Test Suite ─────────────────────────────────────────────────────────────────

let tool: ToolDef;

beforeEach(async () => {
  vi.clearAllMocks();
  vi.resetModules();
  execFileAsyncMock.mockReset();
  // Safe default: resolves with empty stdout so forgotten mock setup
  // does not cause a destructure crash.
  execFileAsyncMock.mockResolvedValue({ stdout: "", stderr: "" });
  setPlatform("linux");

  const mod = await import("../desktop-accessibility.js");
  tool = mod.desktopAccessibilityTool as ToolDef;
});

// ═══════════════════════════════════════════════════════════════════════════
// Tool Registration Metadata
// ═══════════════════════════════════════════════════════════════════════════

describe("tool registration metadata", () => {
  it("has correct tool name", () => {
    expect(tool.name).toBe("desktop_accessibility");
  });

  it("has descriptive text covering all actions", () => {
    expect(tool.description).toContain("Inspect UI elements");
    expect(tool.description).toContain("Accessibility API");
    expect(tool.description).toContain("listApps");
    expect(tool.description).toContain("listWindows");
    expect(tool.description).toContain("getFocusedElement");
    expect(tool.description).toContain("dumpTree");
  });

  it("declares object parameter schema", () => {
    expect(tool.parameters.type).toBe("object");
  });

  it("requires action and only action", () => {
    expect(tool.parameters.required).toContain("action");
    expect(tool.parameters.required).toHaveLength(1);
  });

  it("defines action enum with exactly four values", () => {
    const props = tool.parameters.properties as Record<
      string,
      Record<string, unknown>
    >;
    expect(props.action.enum).toEqual([
      "listApps",
      "listWindows",
      "getFocusedElement",
      "dumpTree",
    ]);
    expect(props.action.type).toBe("string");
  });

  it("exposes optional appName string parameter", () => {
    const props = tool.parameters.properties as Record<
      string,
      Record<string, unknown>
    >;
    expect(props.appName).toBeDefined();
    expect(props.appName.type).toBe("string");
  });

  it("exposes optional x and y coordinate parameters", () => {
    const props = tool.parameters.properties as Record<
      string,
      Record<string, unknown>
    >;
    expect(props.x).toBeDefined();
    expect(props.x.type).toBe("number");
    expect(props.y).toBeDefined();
    expect(props.y.type).toBe("number");
  });

  it("exposes optional maxDepth number parameter", () => {
    const props = tool.parameters.properties as Record<
      string,
      Record<string, unknown>
    >;
    expect(props.maxDepth).toBeDefined();
    expect(props.maxDepth.type).toBe("number");
  });

  it("sets 30 s timeout and low risk level", () => {
    expect(tool.options).toBeDefined();
    expect(tool.options?.timeoutMs).toBe(30_000);
    expect(tool.options?.riskLevel).toBe("low");
  });

  it("provides an executable function", () => {
    expect(typeof tool.execute).toBe("function");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Unsupported Platform
// ═══════════════════════════════════════════════════════════════════════════

describe("unsupported platform", () => {
  it("returns EXEC_ERROR for win32", async () => {
    setPlatform("win32");
    vi.resetModules();
    const mod = await import("../desktop-accessibility.js");
    const winTool = mod.desktopAccessibilityTool as ToolDef;

    const result = await winTool.execute({ action: "listApps" }, makeCtx());

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("EXEC_ERROR");
    expect(result.error?.message).toContain("Unsupported platform");
    expect(result.content).toContain("win32");
  });

  it("returns EXEC_ERROR for other unrecognised platforms", async () => {
    setPlatform("freebsd");
    vi.resetModules();
    const mod = await import("../desktop-accessibility.js");
    const bsdTool = mod.desktopAccessibilityTool as ToolDef;

    const result = await bsdTool.execute({ action: "getFocusedElement" }, makeCtx());

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("EXEC_ERROR");
    expect(result.error?.message).toContain("Unsupported platform");
  });

  it("never calls external commands on unsupported platforms", async () => {
    setPlatform("win32");
    vi.resetModules();
    const mod = await import("../desktop-accessibility.js");
    const winTool = mod.desktopAccessibilityTool as ToolDef;

    await winTool.execute({ action: "listApps" }, makeCtx());
    expect(execFileAsyncMock).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// listApps
// ═══════════════════════════════════════════════════════════════════════════

describe("listApps action", () => {
  it("lists apps on Linux via wmctrl (success path)", async () => {
    execFileAsyncMock.mockResolvedValueOnce({
      stdout: "0x1234  0  hostname Terminal\n0x5678  1  hostname Browser\n",
    });

    const result = await tool.execute({ action: "listApps" }, makeCtx());

    expect(result.ok).toBe(true);
    expect(result.content).toContain("Terminal");
    expect(result.content).toContain("Browser");
    expect(result.metadata?.renderHint).toEqual({ type: "code", lang: "json" });
  });

  it("lists apps on macOS via osascript", async () => {
    setPlatform("darwin");
    vi.resetModules();
    const mod = await import("../desktop-accessibility.js");
    const macTool = mod.desktopAccessibilityTool as ToolDef;

    execFileAsyncMock.mockResolvedValueOnce({
      stdout: '[{"name":"Finder","bundleId":"com.apple.finder","pid":123}]',
    });

    const result = await macTool.execute({ action: "listApps" }, makeCtx());

    expect(result.ok).toBe(true);
    expect(result.content).toContain("Finder");
    expect(execFileAsyncMock).toHaveBeenCalledWith(
      "osascript",
      ["-l", "JavaScript", "-e", expect.any(String)],
      expect.objectContaining({ timeout: 10_000 }),
    );
  });

  it("falls back to xdotool when wmctrl is not found on Linux", async () => {
    execFileAsyncMock.mockRejectedValueOnce(new Error("wmctrl: command not found"));
    execFileAsyncMock.mockResolvedValueOnce({ stdout: "111\n222\n333\n" });

    const result = await tool.execute({ action: "listApps" }, makeCtx());

    expect(result.ok).toBe(true);
    expect(result.content).toContain("windowIds");
    expect(result.content).toContain("111");
  });

  it("returns error when both wmctrl and xdotool fail on Linux", async () => {
    execFileAsyncMock.mockRejectedValueOnce(new Error("wmctrl not found"));
    execFileAsyncMock.mockRejectedValueOnce(new Error("xdotool not found"));

    const result = await tool.execute({ action: "listApps" }, makeCtx());

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("EXEC_ERROR");
    expect(result.error?.message).toContain("Accessibility query failed");
    expect(result.error?.message).toContain("No accessibility tools available");
  });

  it("handles osascript execution failure on macOS", async () => {
    setPlatform("darwin");
    vi.resetModules();
    const mod = await import("../desktop-accessibility.js");
    const macTool = mod.desktopAccessibilityTool as ToolDef;

    execFileAsyncMock.mockRejectedValueOnce(
      new Error("osascript: execution error: No user interaction allowed"),
    );

    const result = await macTool.execute({ action: "listApps" }, makeCtx());

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("EXEC_ERROR");
    expect(result.error?.message).toContain("Accessibility query failed");
    expect(result.error?.message).toContain("osascript");
  });

  it("handles empty wmctrl output on Linux", async () => {
    execFileAsyncMock.mockResolvedValueOnce({ stdout: "" });

    const result = await tool.execute({ action: "listApps" }, makeCtx());

    expect(result.ok).toBe(true);
    expect(result.content).toContain("[]"); // empty JSON array
  });

  it("handles wmctrl output with single entry on Linux", async () => {
    execFileAsyncMock.mockResolvedValueOnce({
      stdout: "0x02a00001  0  myhost My Single Window",
    });

    const result = await tool.execute({ action: "listApps" }, makeCtx());

    expect(result.ok).toBe(true);
    expect(result.content).toContain("0x02a00001");
    expect(result.content).toContain("My Single Window");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// listWindows
// ═══════════════════════════════════════════════════════════════════════════

describe("listWindows action", () => {
  it("returns error when appName is missing", async () => {
    const result = await tool.execute({ action: "listWindows" }, makeCtx());

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("UNKNOWN");
    expect(result.error?.message).toContain("appName is required");
    expect(result.error?.message).toContain("listWindows");
  });

  it("returns error when appName is empty string", async () => {
    const result = await tool.execute(
      { action: "listWindows", appName: "" },
      makeCtx(),
    );

    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain("appName is required");
  });

  it("lists windows on Linux (uses wmctrl backend)", async () => {
    execFileAsyncMock.mockResolvedValueOnce({
      stdout: "0x1234  0  hostname MyApp — Main Window\n",
    });

    const result = await tool.execute(
      { action: "listWindows", appName: "MyApp" },
      makeCtx(),
    );

    expect(result.ok).toBe(true);
    expect(result.content).toContain("Main Window");
  });

  it("lists windows on macOS via osascript", async () => {
    setPlatform("darwin");
    vi.resetModules();
    const mod = await import("../desktop-accessibility.js");
    const macTool = mod.desktopAccessibilityTool as ToolDef;

    execFileAsyncMock.mockResolvedValueOnce({
      stdout: '[{"title":"Untitled 1","position":[100,200],"size":[800,600]}]',
    });

    const result = await macTool.execute(
      { action: "listWindows", appName: "TextEdit" },
      makeCtx(),
    );

    expect(result.ok).toBe(true);
    expect(result.content).toContain("Untitled 1");
    expect(execFileAsyncMock).toHaveBeenCalledWith(
      "osascript",
      ["-l", "JavaScript", "-e", expect.any(String)],
      expect.objectContaining({ timeout: 10_000 }),
    );
  });

  it("handles osascript failure on macOS listWindows", async () => {
    setPlatform("darwin");
    vi.resetModules();
    const mod = await import("../desktop-accessibility.js");
    const macTool = mod.desktopAccessibilityTool as ToolDef;

    execFileAsyncMock.mockRejectedValueOnce(
      new Error("osascript: process not found"),
    );

    const result = await macTool.execute(
      { action: "listWindows", appName: "NonexistentApp" },
      makeCtx(),
    );

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("EXEC_ERROR");
    expect(result.error?.message).toContain("Accessibility query failed");
  });

  it("escapes double-quotes in appName for macOS script", async () => {
    setPlatform("darwin");
    vi.resetModules();
    const mod = await import("../desktop-accessibility.js");
    const macTool = mod.desktopAccessibilityTool as ToolDef;

    execFileAsyncMock.mockResolvedValueOnce({ stdout: "[]" });

    const result = await macTool.execute(
      { action: "listWindows", appName: 'App "With" Quotes' },
      makeCtx(),
    );

    // Should not crash — quotes are escaped inside the generated JavaScript.
    expect(result.ok).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// getFocusedElement
// ═══════════════════════════════════════════════════════════════════════════

describe("getFocusedElement action", () => {
  it("gets focused window on Linux via xdotool", async () => {
    execFileAsyncMock.mockResolvedValueOnce({ stdout: "My Active Window Title\n" });

    const result = await tool.execute(
      { action: "getFocusedElement" },
      makeCtx(),
    );

    expect(result.ok).toBe(true);
    expect(result.content).toContain("focusedWindow");
    expect(result.content).toContain("My Active Window Title");
  });

  it("returns error when xdotool is not available on Linux", async () => {
    execFileAsyncMock.mockRejectedValueOnce(
      new Error("xdotool: command not found"),
    );

    const result = await tool.execute(
      { action: "getFocusedElement" },
      makeCtx(),
    );

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("EXEC_ERROR");
    expect(result.error?.message).toContain("xdotool not installed");
  });

  it("gets focused element on macOS via osascript", async () => {
    setPlatform("darwin");
    vi.resetModules();
    const mod = await import("../desktop-accessibility.js");
    const macTool = mod.desktopAccessibilityTool as ToolDef;

    execFileAsyncMock.mockResolvedValueOnce({
      stdout:
        '{"process":"Safari","window":{"title":"Apple","position":[0,22],"size":[1512,920]}}',
    });

    const result = await macTool.execute(
      { action: "getFocusedElement" },
      makeCtx(),
    );

    expect(result.ok).toBe(true);
    expect(result.content).toContain("Safari");
    expect(result.content).toContain("Apple");
    expect(execFileAsyncMock).toHaveBeenCalledWith(
      "osascript",
      ["-l", "JavaScript", "-e", expect.any(String)],
      expect.objectContaining({ timeout: 10_000 }),
    );
  });

  it("handles osascript failure on macOS getFocusedElement", async () => {
    setPlatform("darwin");
    vi.resetModules();
    const mod = await import("../desktop-accessibility.js");
    const macTool = mod.desktopAccessibilityTool as ToolDef;

    execFileAsyncMock.mockRejectedValueOnce(
      new Error("osascript: execution timed out"),
    );

    const result = await macTool.execute(
      { action: "getFocusedElement" },
      makeCtx(),
    );

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("EXEC_ERROR");
    expect(result.error?.message).toContain("Accessibility query failed");
  });

  it("silently accepts x/y parameters even though not used", async () => {
    setPlatform("darwin");
    vi.resetModules();
    const mod = await import("../desktop-accessibility.js");
    const macTool = mod.desktopAccessibilityTool as ToolDef;

    execFileAsyncMock.mockResolvedValueOnce({
      stdout: '{"process":"Chrome","window":{"title":"Test"}}',
    });

    const result = await macTool.execute(
      { action: "getFocusedElement", x: 100, y: 200 },
      makeCtx(),
    );

    expect(result.ok).toBe(true);
    expect(result.content).toContain("Chrome");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// dumpTree
// ═══════════════════════════════════════════════════════════════════════════

describe("dumpTree action", () => {
  it("returns error when appName is missing", async () => {
    const result = await tool.execute({ action: "dumpTree" }, makeCtx());

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("UNKNOWN");
    expect(result.error?.message).toContain("appName is required");
    expect(result.error?.message).toContain("dumpTree");
  });

  it("returns error when appName is empty string", async () => {
    const result = await tool.execute(
      { action: "dumpTree", appName: "" },
      makeCtx(),
    );

    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain("appName is required");
  });

  it("dumps UI tree on macOS with osascript", async () => {
    setPlatform("darwin");
    vi.resetModules();
    const mod = await import("../desktop-accessibility.js");
    const macTool = mod.desktopAccessibilityTool as ToolDef;

    execFileAsyncMock.mockResolvedValueOnce({
      stdout:
        '{"role":"AXWindow","title":"Calculator","children":[{"role":"AXButton","title":"1"}]}',
    });

    const result = await macTool.execute(
      { action: "dumpTree", appName: "Calculator" },
      makeCtx(),
    );

    expect(result.ok).toBe(true);
    expect(result.content).toContain("AXWindow");
    expect(result.content).toContain("Calculator");
    expect(execFileAsyncMock).toHaveBeenCalledWith(
      "osascript",
      ["-l", "JavaScript", "-e", expect.any(String)],
      expect.objectContaining({
        timeout: 15_000,
        maxBuffer: expect.any(Number) as number,
      }),
    );
  });

  it("defaults maxDepth to 3 on macOS", async () => {
    setPlatform("darwin");
    vi.resetModules();
    const mod = await import("../desktop-accessibility.js");
    const macTool = mod.desktopAccessibilityTool as ToolDef;

    execFileAsyncMock.mockResolvedValueOnce({
      stdout: '{"role":"AXWindow"}',
    });

    await macTool.execute(
      { action: "dumpTree", appName: "Finder" },
      makeCtx(),
    );

    // Script text is the 4th element of the args array (index 3).
    const scriptArg = execFileAsyncMock.mock.calls[0][1][3] as string;
    expect(scriptArg).toContain("depth > 3");
  });

  it("uses custom maxDepth in the generated script on macOS", async () => {
    setPlatform("darwin");
    vi.resetModules();
    const mod = await import("../desktop-accessibility.js");
    const macTool = mod.desktopAccessibilityTool as ToolDef;

    execFileAsyncMock.mockResolvedValueOnce({
      stdout: '{"role":"AXWindow","children":[...]}',
    });

    await macTool.execute(
      { action: "dumpTree", appName: "Safari", maxDepth: 7 },
      makeCtx(),
    );

    const scriptArg = execFileAsyncMock.mock.calls[0][1][3] as string;
    expect(scriptArg).toContain("depth > 7");
  });

  it("passes maxDepth 0 into the script on macOS", async () => {
    setPlatform("darwin");
    vi.resetModules();
    const mod = await import("../desktop-accessibility.js");
    const macTool = mod.desktopAccessibilityTool as ToolDef;

    execFileAsyncMock.mockResolvedValueOnce({ stdout: "{}" });

    const result = await macTool.execute(
      { action: "dumpTree", appName: "Safari", maxDepth: 0 },
      makeCtx(),
    );

    expect(result.ok).toBe(true);
    const scriptArg = execFileAsyncMock.mock.calls[0][1][3] as string;
    expect(scriptArg).toContain("depth > 0");
  });

  it("returns error for dumpTree on Linux (not supported)", async () => {
    const result = await tool.execute(
      { action: "dumpTree", appName: "Safari" },
      makeCtx(),
    );

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("EXEC_ERROR");
    expect(result.error?.message).toContain("dumpTree is only supported on macOS");
  });

  it("handles osascript failure on macOS dumpTree", async () => {
    setPlatform("darwin");
    vi.resetModules();
    const mod = await import("../desktop-accessibility.js");
    const macTool = mod.desktopAccessibilityTool as ToolDef;

    execFileAsyncMock.mockRejectedValueOnce(
      new Error("osascript: execution error: Not authorized"),
    );

    const result = await macTool.execute(
      { action: "dumpTree", appName: "Finder" },
      makeCtx(),
    );

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("EXEC_ERROR");
    expect(result.error?.message).toContain("Accessibility query failed");
  });

  it("escapes double-quotes in appName for macOS dumpTree script", async () => {
    setPlatform("darwin");
    vi.resetModules();
    const mod = await import("../desktop-accessibility.js");
    const macTool = mod.desktopAccessibilityTool as ToolDef;

    execFileAsyncMock.mockResolvedValueOnce({ stdout: "{}" });

    const result = await macTool.execute(
      { action: "dumpTree", appName: 'App "Test"' },
      makeCtx(),
    );

    expect(result.ok).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Unknown / Unimplemented Action
// ═══════════════════════════════════════════════════════════════════════════

describe("unknown action", () => {
  it("returns UNKNOWN error for a random action string", async () => {
    const result = await tool.execute(
      { action: "invalidAction" as any },
      makeCtx(),
    );

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("UNKNOWN");
    expect(result.error?.message).toContain("Unknown action");
    expect(result.error?.message).toContain("invalidAction");
  });

  it("does not call any system command for unknown actions", async () => {
    await tool.execute({ action: "garbage" as any }, makeCtx());
    expect(execFileAsyncMock).not.toHaveBeenCalled();
  });

  it("returns UNKNOWN for getElementAt (declared in type but not implemented)", async () => {
    const result = await tool.execute(
      { action: "getElementAt" as any, x: 100, y: 200 },
      makeCtx(),
    );

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("UNKNOWN");
    expect(result.error?.message).toContain("Unknown action");
    expect(result.error?.message).toContain("getElementAt");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Result Format & Render Hints
// ═══════════════════════════════════════════════════════════════════════════

describe("result format", () => {
  it("includes code/json renderHint on every success result", async () => {
    execFileAsyncMock.mockResolvedValueOnce({ stdout: "ok" });

    const result = await tool.execute(
      { action: "getFocusedElement" },
      makeCtx(),
    );

    expect(result.ok).toBe(true);
    expect(result.metadata?.renderHint).toEqual({
      type: "code",
      lang: "json",
    });
  });

  it("omits renderHint on error results", async () => {
    const result = await tool.execute({ action: "listWindows" }, makeCtx());

    expect(result.ok).toBe(false);
    expect(result.metadata?.renderHint).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Edge Cases — General
// ═══════════════════════════════════════════════════════════════════════════

describe("edge cases", () => {
  it("trims whitespace from stdout", async () => {
    execFileAsyncMock.mockResolvedValueOnce({
      stdout: "   \n  \t  data  \n  ",
    });

    const result = await tool.execute(
      { action: "getFocusedElement" },
      makeCtx(),
    );

    expect(result.ok).toBe(true);
    expect(result.content).not.toContain("\n");
  });

  it("handles empty stdout (getFocusedElement wraps in JSON)", async () => {
    execFileAsyncMock.mockResolvedValueOnce({ stdout: "" });

    const result = await tool.execute(
      { action: "getFocusedElement" },
      makeCtx(),
    );

    expect(result.ok).toBe(true);
    // linuxGetFocused wraps output: JSON.stringify({ focusedWindow: "" })
    expect(result.content).toBe('{"focusedWindow":""}');
  });

  it("catches non-Error throws (string rejection reaching outer catch)", async () => {
    // Use macOS path — macListApps has no inner try/catch, so non-Error
    // rejections propagate directly to the outer catch in execute().
    setPlatform("darwin");
    vi.resetModules();
    const mod = await import("../desktop-accessibility.js");
    const macTool = mod.desktopAccessibilityTool as ToolDef;

    execFileAsyncMock.mockRejectedValueOnce("plain string error");

    const result = await macTool.execute({ action: "listApps" }, makeCtx());

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("EXEC_ERROR");
    expect(result.error?.message).toContain("Accessibility query failed");
    expect(result.error?.message).toContain("plain string error");
  });

  it("catches non-Error throws (object rejection reaching outer catch)", async () => {
    // Use macOS path — macListApps has no inner try/catch.
    setPlatform("darwin");
    vi.resetModules();
    const mod = await import("../desktop-accessibility.js");
    const macTool = mod.desktopAccessibilityTool as ToolDef;

    execFileAsyncMock.mockRejectedValueOnce({ code: 1, reason: "crash" });

    const result = await macTool.execute({ action: "listApps" }, makeCtx());

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("EXEC_ERROR");
    expect(result.error?.message).toContain("Accessibility query failed");
  });

  it("uses the correct error code for platform errors (EXEC_ERROR not UNKNOWN)", async () => {
    setPlatform("win32");
    vi.resetModules();
    const mod = await import("../desktop-accessibility.js");
    const winTool = mod.desktopAccessibilityTool as ToolDef;

    const result = await winTool.execute({ action: "dumpTree" }, makeCtx());

    expect(result.error?.code).toBe("EXEC_ERROR");
    expect(result.error?.retryable).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Darwin Platform Coverage (cross-cutting)
// ═══════════════════════════════════════════════════════════════════════════

describe("darwin platform paths", () => {
  it("uses osascript -l JavaScript for all macOS actions", async () => {
    setPlatform("darwin");
    vi.resetModules();
    const mod = await import("../desktop-accessibility.js");
    const macTool = mod.desktopAccessibilityTool as ToolDef;

    execFileAsyncMock.mockResolvedValueOnce({ stdout: "[]" });
    execFileAsyncMock.mockResolvedValueOnce({ stdout: "[]" });
    execFileAsyncMock.mockResolvedValueOnce({ stdout: "{}" });
    execFileAsyncMock.mockResolvedValueOnce({ stdout: "{}" });

    await macTool.execute({ action: "listApps" }, makeCtx());
    await macTool.execute(
      { action: "listWindows", appName: "Finder" },
      makeCtx(),
    );
    await macTool.execute({ action: "getFocusedElement" }, makeCtx());
    await macTool.execute(
      { action: "dumpTree", appName: "Finder" },
      makeCtx(),
    );

    // Every call should use osascript with -l JavaScript.
    const calls = execFileAsyncMock.mock.calls;
    expect(calls).toHaveLength(4);
    for (const call of calls) {
      expect(call[0]).toBe("osascript");
      expect(call[1]).toEqual(["-l", "JavaScript", "-e", expect.any(String)]);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Linux Platform Coverage (cross-cutting)
// ═══════════════════════════════════════════════════════════════════════════

describe("linux platform paths", () => {
  it("uses wmctrl for listApps on Linux", async () => {
    execFileAsyncMock.mockResolvedValueOnce({
      stdout: "0x02  0  h  App\n",
    });

    await tool.execute({ action: "listApps" }, makeCtx());

    expect(execFileAsyncMock.mock.calls[0]).toEqual([
      "wmctrl",
      ["-l"],
      { timeout: 5_000 },
    ]);
  });

  it("uses xdotool for getFocusedElement on Linux", async () => {
    execFileAsyncMock.mockResolvedValueOnce({ stdout: "Window\n" });

    await tool.execute({ action: "getFocusedElement" }, makeCtx());

    expect(execFileAsyncMock.mock.calls[0]).toEqual([
      "xdotool",
      ["getactivewindow", "getwindowname"],
      { timeout: 5_000 },
    ]);
  });

  it("listWindows on Linux delegates to wmctrl (list-all-windows)", async () => {
    execFileAsyncMock.mockResolvedValueOnce({
      stdout: "0x03  1  host  Window\n",
    });

    await tool.execute(
      { action: "listWindows", appName: "Anything" },
      makeCtx(),
    );

    expect(execFileAsyncMock.mock.calls[0][0]).toBe("wmctrl");
  });
});
