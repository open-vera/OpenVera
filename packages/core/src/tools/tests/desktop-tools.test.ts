// Tests for desktop automation tools (CU5-CU9)
//
// Mock approach: mock the entire node:util promisify so execFileAsync/execAsync
// use our controlled implementations directly.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ToolContext } from "../types.js";

// ── Mock state ─────────────────────────────────────────────────────────────────

let nextResult: { ok: boolean; stdout: string; stderr: string } = {
  ok: true,
  stdout: "",
  stderr: "",
};

function mockResolve(stdout = "", stderr = "") {
  nextResult = { ok: true, stdout, stderr };
}
function mockReject(msg: string) {
  nextResult = { ok: false, stdout: "", stderr: msg };
}

// ── Mocks ──────────────────────────────────────────────────────────────────────

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
  exec: vi.fn(),
}));

// Mock promisify so it returns a function that uses our controlled result
vi.mock("node:util", async () => {
  const actual = await vi.importActual<typeof import("node:util")>("node:util");
  return {
    ...actual,
    promisify: vi.fn((fn: Function) => {
      // Return a function that resolves/rejects based on nextResult
      return (...args: unknown[]) => {
        return new Promise((resolve, reject) => {
          if (nextResult.ok) {
            resolve({ stdout: nextResult.stdout, stderr: nextResult.stderr });
          } else {
            const err = new Error(nextResult.stderr || "mock error");
            (err as any).stdout = nextResult.stdout;
            (err as any).stderr = nextResult.stderr;
            reject(err);
          }
        });
      };
    }),
  };
});

vi.mock("node:fs/promises", () => ({
  writeFile: vi.fn().mockResolvedValue(undefined),
  readFile: vi.fn().mockResolvedValue("{}"),
  mkdir: vi.fn().mockResolvedValue(undefined),
}));

const mockCtx: ToolContext = {
  cwd: "/tmp/test",
  sessionId: "test-session",
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  mockResolve();
  Object.defineProperty(process, "platform", { value: "linux", writable: true });
});

// ── CU5: desktop_screenshot ────────────────────────────────────────────────────

describe("CU5: desktop_screenshot", () => {
  it("should be registered with correct name", async () => {
    const { desktopScreenshotTool } = await import("../desktop-screenshot.js");
    expect(desktopScreenshotTool.name).toBe("desktop_screenshot");
  });

  it("should have correct description and parameters", async () => {
    const { desktopScreenshotTool } = await import("../desktop-screenshot.js");
    expect(desktopScreenshotTool.description).toContain("screenshot");
    expect(desktopScreenshotTool.parameters).toHaveProperty("properties");
  });

  it("should capture fullscreen screenshot on Linux (scrot)", async () => {
    const { desktopScreenshotTool } = await import("../desktop-screenshot.js");
    mockResolve();
    const result = await desktopScreenshotTool.execute(
      { mode: "fullscreen" },
      mockCtx
    );
    expect(result.ok).toBe(true);
    expect(result.content).toContain("fullscreen");
  });

  it("should return error on unsupported platform", async () => {
    const { desktopScreenshotTool } = await import("../desktop-screenshot.js");
    Object.defineProperty(process, "platform", { value: "win32", writable: true });
    const result = await desktopScreenshotTool.execute({}, mockCtx);
    expect(result.ok).toBe(false);
    expect(result.content).toContain("Unsupported platform");
  });

  it("should use custom path when provided", async () => {
    const { desktopScreenshotTool } = await import("../desktop-screenshot.js");
    mockResolve();
    const result = await desktopScreenshotTool.execute(
      { path: "/tmp/custom-shot.png" },
      mockCtx
    );
    expect(result.ok).toBe(true);
    expect(result.content).toContain("/tmp/custom-shot.png");
  });
});

// ── CU6: desktop_input ─────────────────────────────────────────────────────────

describe("CU6: desktop_input", () => {
  it("should be registered with correct name", async () => {
    const { desktopInputTool } = await import("../desktop-input.js");
    expect(desktopInputTool.name).toBe("desktop_input");
  });

  it("should have correct description", async () => {
    const { desktopInputTool } = await import("../desktop-input.js");
    expect(desktopInputTool.description).toContain("mouse");
    expect(desktopInputTool.description).toContain("keyboard");
  });

  it("should click at coordinates on Linux (xdotool)", async () => {
    const { desktopInputTool } = await import("../desktop-input.js");
    mockResolve();
    const result = await desktopInputTool.execute(
      { action: "click", x: 100, y: 200 },
      mockCtx
    );
    expect(result.ok).toBe(true);
    expect(result.content).toContain("100");
    expect(result.content).toContain("200");
  });

  it("should type text on Linux", async () => {
    const { desktopInputTool } = await import("../desktop-input.js");
    mockResolve();
    const result = await desktopInputTool.execute(
      { action: "type", text: "hello world" },
      mockCtx
    );
    expect(result.ok).toBe(true);
    expect(result.content).toContain("hello world");
  });

  it("should require x/y for click action", async () => {
    const { desktopInputTool } = await import("../desktop-input.js");
    const result = await desktopInputTool.execute(
      { action: "click" },
      mockCtx
    );
    expect(result.ok).toBe(false);
    expect(result.content).toContain("x and y are required");
  });

  it("should execute hotkey on Linux", async () => {
    const { desktopInputTool } = await import("../desktop-input.js");
    mockResolve();
    const result = await desktopInputTool.execute(
      { action: "hotkey", key: "c", modifiers: ["ctrl", "shift"] },
      mockCtx
    );
    expect(result.ok).toBe(true);
    expect(result.content).toContain("ctrl+shift+c");
  });
});

// ── CU7: desktop_script ────────────────────────────────────────────────────────

describe("CU7: desktop_script", () => {
  it("should be registered with correct name", async () => {
    const { desktopScriptTool } = await import("../desktop-script.js");
    expect(desktopScriptTool.name).toBe("desktop_script");
  });

  it("should execute shell script", async () => {
    const { desktopScriptTool } = await import("../desktop-script.js");
    mockResolve("hello output");
    const result = await desktopScriptTool.execute(
      { type: "shell", script: "echo hello" },
      mockCtx
    );
    expect(result.ok).toBe(true);
    expect(result.content).toContain("hello output");
  });

  it("should handle shell script errors", async () => {
    const { desktopScriptTool } = await import("../desktop-script.js");
    mockReject("command not found");
    const result = await desktopScriptTool.execute(
      { type: "shell", script: "nonexistent_command" },
      mockCtx
    );
    expect(result.ok).toBe(false);
    expect(result.content).toContain("Script execution failed");
  });

  it("should reject applescript on non-macOS", async () => {
    const { desktopScriptTool } = await import("../desktop-script.js");
    const result = await desktopScriptTool.execute(
      { type: "applescript", script: 'tell app "Finder"' },
      mockCtx
    );
    expect(result.ok).toBe(false);
    expect(result.content).toContain("only supported on macOS");
  });
});

// ── CU8: desktop_accessibility ─────────────────────────────────────────────────

describe("CU8: desktop_accessibility", () => {
  it("should be registered with correct name", async () => {
    const { desktopAccessibilityTool } = await import("../desktop-accessibility.js");
    expect(desktopAccessibilityTool.name).toBe("desktop_accessibility");
  });

  it("should list apps on Linux (wmctrl)", async () => {
    const { desktopAccessibilityTool } = await import("../desktop-accessibility.js");
    mockResolve("0x1234  0  hostname Window Title\n");
    const result = await desktopAccessibilityTool.execute(
      { action: "listApps" },
      mockCtx
    );
    expect(result.ok).toBe(true);
    expect(result.content).toContain("Window Title");
  });

  it("should get focused element on Linux", async () => {
    const { desktopAccessibilityTool } = await import("../desktop-accessibility.js");
    mockResolve("My Window");
    const result = await desktopAccessibilityTool.execute(
      { action: "getFocusedElement" },
      mockCtx
    );
    expect(result.ok).toBe(true);
    expect(result.content).toContain("My Window");
  });

  it("should require appName for listWindows", async () => {
    const { desktopAccessibilityTool } = await import("../desktop-accessibility.js");
    const result = await desktopAccessibilityTool.execute(
      { action: "listWindows" },
      mockCtx
    );
    expect(result.ok).toBe(false);
    expect(result.content).toContain("appName is required");
  });
});

// ── CU9: Integration ──────────────────────────────────────────────────────────

describe("CU9: Desktop tools integration", () => {
  it("all desktop tools should be importable", async () => {
    const screenshot = await import("../desktop-screenshot.js");
    const input = await import("../desktop-input.js");
    const script = await import("../desktop-script.js");
    const accessibility = await import("../desktop-accessibility.js");

    expect(screenshot.desktopScreenshotTool.name).toBe("desktop_screenshot");
    expect(input.desktopInputTool.name).toBe("desktop_input");
    expect(script.desktopScriptTool.name).toBe("desktop_script");
    expect(accessibility.desktopAccessibilityTool.name).toBe("desktop_accessibility");
  });

  it("all tools should have required fields", async () => {
    const tools = [
      (await import("../desktop-screenshot.js")).desktopScreenshotTool,
      (await import("../desktop-input.js")).desktopInputTool,
      (await import("../desktop-script.js")).desktopScriptTool,
      (await import("../desktop-accessibility.js")).desktopAccessibilityTool,
    ];
    for (const tool of tools) {
      expect(tool.name).toBeTruthy();
      expect(tool.description).toBeTruthy();
      expect(tool.parameters).toBeTruthy();
      expect(typeof tool.execute).toBe("function");
    }
  });
});
