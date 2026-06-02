/**
 * Tests for desktop-input tool — mouse / keyboard simulation.
 *
 * Mock approach: mock node:child_process & node:util so that promisified
 * execFileAsync resolves/rejects under test control. Tests cover all 8
 * actions on both macOS and Linux, parameter validation, error branches,
 * metadata, and edge cases.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import type { ToolContext } from "../types.js";

// ── Mock state ─────────────────────────────────────────────────────────────────

const { execFileAsyncMock } = vi.hoisted(() => ({
  execFileAsyncMock: vi.fn(),
}));

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

// ── Import after mock ──────────────────────────────────────────────────────────

import { desktopInputTool } from "../desktop-input.js";

// ── Helpers ────────────────────────────────────────────────────────────────────

const mockCtx: ToolContext = {
  cwd: "/tmp/test",
  sessionId: "test-session",
};

const REAL_PLATFORM = process.platform;

function setPlatform(platform: string) {
  Object.defineProperty(process, "platform", {
    value: platform,
    writable: true,
    configurable: true,
  });
}

function setupExecSuccess(stdout = "") {
  execFileAsyncMock.mockResolvedValue({ stdout, stderr: "" });
}

function setupExecFailure(message: string) {
  execFileAsyncMock.mockRejectedValue(new Error(message));
}

// Default to macOS + success, reset between tests
beforeEach(() => {
  vi.clearAllMocks();
  setPlatform("darwin");
  setupExecSuccess();
});

afterAll(() => {
  setPlatform(REAL_PLATFORM);
});

// ── Metadata ───────────────────────────────────────────────────────────────────

describe("metadata", () => {
  it("has correct name", () => {
    expect(desktopInputTool.name).toBe("desktop_input");
  });

  it("has description mentioning desktop simulation and supported tools", () => {
    expect(desktopInputTool.description).toContain("Simulate mouse and keyboard");
    expect(desktopInputTool.description).toContain("cliclick");
    expect(desktopInputTool.description).toContain("xdotool");
    expect(desktopInputTool.description).toContain("osascript");
  });

  it("declares all 8 actions in parameters enum", () => {
    const props = (desktopInputTool.parameters as Record<string, unknown>)
      .properties as Record<string, unknown>;
    const actionEnum = (props.action as Record<string, unknown>).enum as string[];
    expect(actionEnum).toEqual([
      "click",
      "doubleClick",
      "rightClick",
      "move",
      "type",
      "key",
      "hotkey",
      "scroll",
    ]);
  });

  it("only requires the action parameter", () => {
    const required = (desktopInputTool.parameters as Record<string, unknown>)
      .required as string[];
    expect(required).toEqual(["action"]);
  });

  it("has 15s timeout and medium risk level", () => {
    expect(desktopInputTool.options).toEqual({
      timeoutMs: 15_000,
      riskLevel: "medium",
    });
  });

  it("defines all optional parameter schemas", () => {
    const props = (desktopInputTool.parameters as Record<string, unknown>)
      .properties as Record<string, unknown>;
    expect(props).toHaveProperty("x");
    expect(props).toHaveProperty("y");
    expect(props).toHaveProperty("text");
    expect(props).toHaveProperty("key");
    expect(props).toHaveProperty("modifiers");
    expect(props).toHaveProperty("scrollX");
    expect(props).toHaveProperty("scrollY");
    expect(props).toHaveProperty("typeDelay");
  });
});

// ── Unsupported platform ──────────────────────────────────────────────────────

describe("unsupported platform", () => {
  it("returns EXEC_ERROR for non-darwin/non-linux platform", async () => {
    setPlatform("win32");
    const result = await desktopInputTool.execute(
      { action: "click", x: 100, y: 200 },
      mockCtx,
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("EXEC_ERROR");
    expect(result.error?.message).toContain("Unsupported platform");
    expect(result.error?.message).toContain("win32");
  });
});

// ── Unknown action ────────────────────────────────────────────────────────────

describe("unknown action", () => {
  it("returns UNKNOWN error for unrecognized action name", async () => {
    const result = await desktopInputTool.execute(
      { action: "unknown" as any },
      mockCtx,
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("UNKNOWN");
    expect(result.error?.message).toContain("Unknown action");
    expect(result.error?.message).toContain("unknown");
  });
});

// ── Parameter validation (platform-agnostic) ──────────────────────────────────

describe("parameter validation", () => {
  it("click requires x and y", async () => {
    const r = await desktopInputTool.execute({ action: "click" }, mockCtx);
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("UNKNOWN");
    expect(r.error?.message).toContain("x and y are required");
  });

  it("doubleClick requires x and y", async () => {
    const r = await desktopInputTool.execute(
      { action: "doubleClick" },
      mockCtx,
    );
    expect(r.ok).toBe(false);
    expect(r.error?.message).toContain("x and y are required");
  });

  it("rightClick requires x and y", async () => {
    const r = await desktopInputTool.execute(
      { action: "rightClick" },
      mockCtx,
    );
    expect(r.ok).toBe(false);
    expect(r.error?.message).toContain("x and y are required");
  });

  it("move requires x and y", async () => {
    const r = await desktopInputTool.execute({ action: "move" }, mockCtx);
    expect(r.ok).toBe(false);
    expect(r.error?.message).toContain("x and y are required");
  });

  it("type requires text", async () => {
    const r = await desktopInputTool.execute({ action: "type" }, mockCtx);
    expect(r.ok).toBe(false);
    expect(r.error?.message).toContain("text is required");
  });

  it("key requires key name", async () => {
    const r = await desktopInputTool.execute({ action: "key" }, mockCtx);
    expect(r.ok).toBe(false);
    expect(r.error?.message).toContain("key is required");
  });

  it("hotkey requires key", async () => {
    const r = await desktopInputTool.execute(
      { action: "hotkey", modifiers: ["ctrl"] },
      mockCtx,
    );
    expect(r.ok).toBe(false);
    expect(r.error?.message).toContain("key is required");
  });

  it("hotkey requires non-empty modifiers array", async () => {
    const r = await desktopInputTool.execute(
      { action: "hotkey", key: "a", modifiers: [] },
      mockCtx,
    );
    expect(r.ok).toBe(false);
    expect(r.error?.message).toContain("modifiers array is required");
  });

  it("hotkey requires modifiers (undefined)", async () => {
    const r = await desktopInputTool.execute(
      { action: "hotkey", key: "a" },
      mockCtx,
    );
    expect(r.ok).toBe(false);
    expect(r.error?.message).toContain("modifiers array is required");
  });

  it("scroll requires non-zero scrollX or scrollY (both missing)", async () => {
    const r = await desktopInputTool.execute({ action: "scroll" }, mockCtx);
    expect(r.ok).toBe(false);
    expect(r.error?.message).toContain("scrollX or scrollY is required");
  });

  it("scroll with both zero values is rejected", async () => {
    const r = await desktopInputTool.execute(
      { action: "scroll", scrollX: 0, scrollY: 0 },
      mockCtx,
    );
    expect(r.ok).toBe(false);
    expect(r.error?.message).toContain("scrollX or scrollY is required");
  });
});

// ── macOS (darwin) execute paths ───────────────────────────────────────────────

describe("on macOS (darwin)", () => {
  beforeEach(() => {
    setPlatform("darwin");
    setupExecSuccess();
  });

  describe("click", () => {
    it("performs left click at coordinates via cliclick", async () => {
      const result = await desktopInputTool.execute(
        { action: "click", x: 100, y: 200 },
        mockCtx,
      );
      expect(result.ok).toBe(true);
      expect(result.content).toBe("Clicked at (100, 200)");
      expect(execFileAsyncMock).toHaveBeenCalledWith("cliclick", [
        "c:",
        "100,200",
      ]);
    });

    it("accepts zero coordinates (x=0 not falsy-check)", async () => {
      const result = await desktopInputTool.execute(
        { action: "click", x: 0, y: 0 },
        mockCtx,
      );
      expect(result.ok).toBe(true);
      expect(result.content).toBe("Clicked at (0, 0)");
    });

    it("accepts negative coordinates", async () => {
      const result = await desktopInputTool.execute(
        { action: "click", x: -10, y: -20 },
        mockCtx,
      );
      expect(result.ok).toBe(true);
      expect(result.content).toBe("Clicked at (-10, -20)");
    });
  });

  describe("doubleClick", () => {
    it("double-clicks at coordinates via cliclick dc:", async () => {
      const result = await desktopInputTool.execute(
        { action: "doubleClick", x: 50, y: 75 },
        mockCtx,
      );
      expect(result.ok).toBe(true);
      expect(result.content).toBe("Double-clicked at (50, 75)");
      expect(execFileAsyncMock).toHaveBeenCalledWith("cliclick", [
        "dc:",
        "50,75",
      ]);
    });
  });

  describe("rightClick", () => {
    it("right-clicks at coordinates via cliclick rc:", async () => {
      const result = await desktopInputTool.execute(
        { action: "rightClick", x: 30, y: 40 },
        mockCtx,
      );
      expect(result.ok).toBe(true);
      expect(result.content).toBe("Right-clicked at (30, 40)");
      expect(execFileAsyncMock).toHaveBeenCalledWith("cliclick", [
        "rc:",
        "30,40",
      ]);
    });
  });

  describe("move", () => {
    it("moves mouse to coordinates via cliclick m:", async () => {
      const result = await desktopInputTool.execute(
        { action: "move", x: 300, y: 400 },
        mockCtx,
      );
      expect(result.ok).toBe(true);
      expect(result.content).toBe("Mouse moved to (300, 400)");
      expect(execFileAsyncMock).toHaveBeenCalledWith("cliclick", [
        "m:",
        "300,400",
      ]);
    });
  });

  describe("type", () => {
    it("types text via osascript keystroke", async () => {
      const result = await desktopInputTool.execute(
        { action: "type", text: "hello" },
        mockCtx,
      );
      expect(result.ok).toBe(true);
      expect(result.content).toBe('Typed: "hello"');
      expect(execFileAsyncMock).toHaveBeenCalledWith("osascript", [
        "-e",
        expect.stringContaining('keystroke "hello"'),
      ]);
    });

    it("escapes double quotes in osascript text", async () => {
      await desktopInputTool.execute(
        { action: "type", text: 'say "hi"' },
        mockCtx,
      );
      const call = execFileAsyncMock.mock.calls[0] as [string, string[]];
      expect(call[1][1]).toContain('say \\"hi\\"');
    });

    it("escapes backslashes in osascript text", async () => {
      await desktopInputTool.execute(
        { action: "type", text: "C:\\path" },
        mockCtx,
      );
      const call = execFileAsyncMock.mock.calls[0] as [string, string[]];
      expect(call[1][1]).toContain("C:\\\\path");
    });

    it("types empty string", async () => {
      const result = await desktopInputTool.execute(
        { action: "type", text: "" },
        mockCtx,
      );
      expect(result.ok).toBe(true);
      expect(result.content).toBe('Typed: ""');
    });

    it("types special characters", async () => {
      const result = await desktopInputTool.execute(
        { action: "type", text: "!@#$%^&*()" },
        mockCtx,
      );
      expect(result.ok).toBe(true);
      expect(result.content).toBe('Typed: "!@#$%^&*()"');
    });

    it("types unicode text", async () => {
      const result = await desktopInputTool.execute(
        { action: "type", text: "你好世界" },
        mockCtx,
      );
      expect(result.ok).toBe(true);
      expect(result.content).toBe('Typed: "你好世界"');
    });

    describe("with typeDelay > 0", () => {
      beforeEach(() => {
        // Make setTimeout fire immediately so the per-char loop doesn't hang
        vi.spyOn(global, "setTimeout").mockImplementation(
          (fn: Function) => (fn(), 1 as any),
        );
      });

      afterEach(() => {
        vi.restoreAllMocks();
      });

      it("types character by character via cliclick t:", async () => {
        const result = await desktopInputTool.execute(
          { action: "type", text: "abc", typeDelay: 10 },
          mockCtx,
        );
        expect(result.ok).toBe(true);
        expect(result.content).toBe('Typed: "abc"');
        // One call per character
        expect(execFileAsyncMock).toHaveBeenCalledTimes(3);
        expect(execFileAsyncMock).toHaveBeenNthCalledWith(1, "cliclick", [
          "t:",
          "a",
        ]);
        expect(execFileAsyncMock).toHaveBeenNthCalledWith(2, "cliclick", [
          "t:",
          "b",
        ]);
        expect(execFileAsyncMock).toHaveBeenNthCalledWith(3, "cliclick", [
          "t:",
          "c",
        ]);
      });
    });

    it("uses osascript when typeDelay is 0", async () => {
      await desktopInputTool.execute(
        { action: "type", text: "hi", typeDelay: 0 },
        mockCtx,
      );
      expect(execFileAsyncMock).toHaveBeenCalledWith(
        "osascript",
        expect.any(Array),
      );
    });

    it("uses osascript when typeDelay is negative", async () => {
      await desktopInputTool.execute(
        { action: "type", text: "hi", typeDelay: -1 },
        mockCtx,
      );
      expect(execFileAsyncMock).toHaveBeenCalledWith(
        "osascript",
        expect.any(Array),
      );
    });
  });

  describe("key", () => {
    it("presses a key via osascript key code", async () => {
      const result = await desktopInputTool.execute(
        { action: "key", key: "return" },
        mockCtx,
      );
      expect(result.ok).toBe(true);
      expect(result.content).toBe("Pressed key: return");
      expect(execFileAsyncMock).toHaveBeenCalledWith("osascript", [
        "-e",
        expect.stringContaining("key code (ASCII number"),
      ]);
    });

    it("maps 'escape' key name in osascript", async () => {
      await desktopInputTool.execute(
        { action: "key", key: "escape" },
        mockCtx,
      );
      const call = execFileAsyncMock.mock.calls[0] as [string, string[]];
      expect(call[1][1]).toContain('ASCII number "escape"');
    });

    it("maps 'backspace' to 'delete' in osascript", async () => {
      await desktopInputTool.execute(
        { action: "key", key: "backspace" },
        mockCtx,
      );
      const call = execFileAsyncMock.mock.calls[0] as [string, string[]];
      expect(call[1][1]).toContain('ASCII number "delete"');
    });

    it("maps 'delete' to 'forward_delete' in osascript", async () => {
      await desktopInputTool.execute(
        { action: "key", key: "delete" },
        mockCtx,
      );
      const call = execFileAsyncMock.mock.calls[0] as [string, string[]];
      expect(call[1][1]).toContain('ASCII number "forward_delete"');
    });

    it("maps 'up' to 'up arrow' in osascript", async () => {
      await desktopInputTool.execute({ action: "key", key: "up" }, mockCtx);
      const call = execFileAsyncMock.mock.calls[0] as [string, string[]];
      expect(call[1][1]).toContain('ASCII number "up arrow"');
    });

    it("maps 'down' to 'down arrow' in osascript", async () => {
      await desktopInputTool.execute({ action: "key", key: "down" }, mockCtx);
      const call = execFileAsyncMock.mock.calls[0] as [string, string[]];
      expect(call[1][1]).toContain('ASCII number "down arrow"');
    });

    it("passes through unknown key names unchanged", async () => {
      await desktopInputTool.execute({ action: "key", key: "f5" }, mockCtx);
      const call = execFileAsyncMock.mock.calls[0] as [string, string[]];
      expect(call[1][1]).toContain('ASCII number "f5"');
    });

    it("is case-insensitive for key name lookup", async () => {
      await desktopInputTool.execute(
        { action: "key", key: "RETURN" },
        mockCtx,
      );
      const call = execFileAsyncMock.mock.calls[0] as [string, string[]];
      // "RETURN" → "return" → maps to "return"
      expect(call[1][1]).toContain('ASCII number "return"');
    });
  });

  describe("hotkey", () => {
    it("sends key combo via osascript keystroke using", async () => {
      const result = await desktopInputTool.execute(
        { action: "hotkey", modifiers: ["cmd"], key: "c" },
        mockCtx,
      );
      expect(result.ok).toBe(true);
      expect(result.content).toBe("Hotkey: cmd+c");
      expect(execFileAsyncMock).toHaveBeenCalledWith("osascript", [
        "-e",
        expect.stringContaining("command down"),
      ]);
    });

    it("maps ctrl→control and alt→option for osascript", async () => {
      await desktopInputTool.execute(
        { action: "hotkey", modifiers: ["ctrl", "alt", "shift"], key: "x" },
        mockCtx,
      );
      const call = execFileAsyncMock.mock.calls[0] as [string, string[]];
      expect(call[1][1]).toContain("control down");
      expect(call[1][1]).toContain("option down");
      expect(call[1][1]).toContain("shift down");
    });

    it("maps 'command' alias to 'command'", async () => {
      await desktopInputTool.execute(
        { action: "hotkey", modifiers: ["command"], key: "v" },
        mockCtx,
      );
      const call = execFileAsyncMock.mock.calls[0] as [string, string[]];
      expect(call[1][1]).toContain("command down");
    });

    it("passes through unrecognized modifier names", async () => {
      await desktopInputTool.execute(
        { action: "hotkey", modifiers: ["hyper"], key: "z" },
        mockCtx,
      );
      const call = execFileAsyncMock.mock.calls[0] as [string, string[]];
      expect(call[1][1]).toContain("hyper down");
    });

    it("lowercases modifier names", async () => {
      await desktopInputTool.execute(
        { action: "hotkey", modifiers: ["CTRL"], key: "a" },
        mockCtx,
      );
      const call = execFileAsyncMock.mock.calls[0] as [string, string[]];
      expect(call[1][1]).toContain("control down");
    });

    it("joins multiple modifiers with comma in content", async () => {
      const result = await desktopInputTool.execute(
        { action: "hotkey", modifiers: ["ctrl", "shift"], key: "t" },
        mockCtx,
      );
      expect(result.content).toBe("Hotkey: ctrl+shift+t");
    });
  });

  describe("scroll", () => {
    it("scrolls via cliclick with scroll coordinates", async () => {
      const result = await desktopInputTool.execute(
        { action: "scroll", scrollX: 1, scrollY: -3 },
        mockCtx,
      );
      expect(result.ok).toBe(true);
      expect(result.content).toBe("Scrolled (1, -3)");
      expect(execFileAsyncMock).toHaveBeenCalledWith("cliclick", [
        "sf:0,0",
        "scroll:1,-3",
      ]);
    });

    it("defaults scrollX to 0 when omitted", async () => {
      const result = await desktopInputTool.execute(
        { action: "scroll", scrollY: 5 },
        mockCtx,
      );
      expect(result.ok).toBe(true);
      expect(result.content).toBe("Scrolled (0, 5)");
    });

    it("defaults scrollY to 0 when omitted", async () => {
      const result = await desktopInputTool.execute(
        { action: "scroll", scrollX: 3 },
        mockCtx,
      );
      expect(result.ok).toBe(true);
      expect(result.content).toBe("Scrolled (3, 0)");
    });
  });
});

// ── Linux execute paths ────────────────────────────────────────────────────────

describe("on Linux", () => {
  beforeEach(() => {
    setPlatform("linux");
    setupExecSuccess();
  });

  describe("click", () => {
    it("moves mouse then left-clicks via xdotool", async () => {
      const result = await desktopInputTool.execute(
        { action: "click", x: 100, y: 200 },
        mockCtx,
      );
      expect(result.ok).toBe(true);
      expect(result.content).toBe("Clicked at (100, 200)");
      expect(execFileAsyncMock).toHaveBeenCalledWith("xdotool", [
        "mousemove",
        "100",
        "200",
      ]);
      expect(execFileAsyncMock).toHaveBeenCalledWith("xdotool", [
        "click",
        "1",
      ]);
      expect(execFileAsyncMock).toHaveBeenCalledTimes(2);
    });
  });

  describe("doubleClick", () => {
    it("moves mouse then double-clicks via xdotool repeat", async () => {
      const result = await desktopInputTool.execute(
        { action: "doubleClick", x: 10, y: 20 },
        mockCtx,
      );
      expect(result.ok).toBe(true);
      expect(result.content).toBe("Double-clicked at (10, 20)");
      expect(execFileAsyncMock).toHaveBeenCalledWith("xdotool", [
        "mousemove",
        "10",
        "20",
      ]);
      expect(execFileAsyncMock).toHaveBeenCalledWith("xdotool", [
        "click",
        "--repeat",
        "2",
        "1",
      ]);
    });
  });

  describe("rightClick", () => {
    it("moves mouse then right-clicks (button 3) via xdotool", async () => {
      const result = await desktopInputTool.execute(
        { action: "rightClick", x: 5, y: 10 },
        mockCtx,
      );
      expect(result.ok).toBe(true);
      expect(result.content).toBe("Right-clicked at (5, 10)");
      expect(execFileAsyncMock).toHaveBeenCalledWith("xdotool", [
        "mousemove",
        "5",
        "10",
      ]);
      expect(execFileAsyncMock).toHaveBeenCalledWith("xdotool", [
        "click",
        "3",
      ]);
    });
  });

  describe("move", () => {
    it("moves mouse via xdotool mousemove", async () => {
      const result = await desktopInputTool.execute(
        { action: "move", x: 42, y: 84 },
        mockCtx,
      );
      expect(result.ok).toBe(true);
      expect(result.content).toBe("Mouse moved to (42, 84)");
      expect(execFileAsyncMock).toHaveBeenCalledWith("xdotool", [
        "mousemove",
        "42",
        "84",
      ]);
    });
  });

  describe("type", () => {
    it("types text via xdotool type", async () => {
      const result = await desktopInputTool.execute(
        { action: "type", text: "hello linux" },
        mockCtx,
      );
      expect(result.ok).toBe(true);
      expect(result.content).toBe('Typed: "hello linux"');
      expect(execFileAsyncMock).toHaveBeenCalledWith("xdotool", [
        "type",
        "hello linux",
      ]);
    });

    it("types with delay via xdotool type --delay", async () => {
      await desktopInputTool.execute(
        { action: "type", text: "abc", typeDelay: 50 },
        mockCtx,
      );
      expect(execFileAsyncMock).toHaveBeenCalledWith("xdotool", [
        "type",
        "--delay",
        "50",
        "abc",
      ]);
    });

    it("types without delay when typeDelay is 0", async () => {
      await desktopInputTool.execute(
        { action: "type", text: "test", typeDelay: 0 },
        mockCtx,
      );
      expect(execFileAsyncMock).toHaveBeenCalledWith("xdotool", [
        "type",
        "test",
      ]);
    });

    it("types without delay when typeDelay is negative", async () => {
      await desktopInputTool.execute(
        { action: "type", text: "test", typeDelay: -5 },
        mockCtx,
      );
      expect(execFileAsyncMock).toHaveBeenCalledWith("xdotool", [
        "type",
        "test",
      ]);
    });
  });

  describe("key", () => {
    it("presses key via xdotool key", async () => {
      const result = await desktopInputTool.execute(
        { action: "key", key: "Return" },
        mockCtx,
      );
      expect(result.ok).toBe(true);
      expect(result.content).toBe("Pressed key: Return");
      expect(execFileAsyncMock).toHaveBeenCalledWith("xdotool", [
        "key",
        "Return",
      ]);
    });
  });

  describe("hotkey", () => {
    it("sends key combo as single +-separated argument", async () => {
      const result = await desktopInputTool.execute(
        { action: "hotkey", modifiers: ["ctrl"], key: "c" },
        mockCtx,
      );
      expect(result.ok).toBe(true);
      expect(result.content).toBe("Hotkey: ctrl+c");
      expect(execFileAsyncMock).toHaveBeenCalledWith("xdotool", [
        "key",
        "ctrl+c",
      ]);
    });

    it("joins multiple modifiers with +", async () => {
      await desktopInputTool.execute(
        { action: "hotkey", modifiers: ["ctrl", "shift", "alt"], key: "t" },
        mockCtx,
      );
      expect(execFileAsyncMock).toHaveBeenCalledWith("xdotool", [
        "key",
        "ctrl+shift+alt+t",
      ]);
    });
  });

  describe("scroll", () => {
    it("scrolls down with button 5 for positive scrollY", async () => {
      const result = await desktopInputTool.execute(
        { action: "scroll", scrollY: 3 },
        mockCtx,
      );
      expect(result.ok).toBe(true);
      expect(result.content).toBe("Scrolled (0, 3)");
      // abs(3) = 3 clicks of button 5
      expect(execFileAsyncMock).toHaveBeenCalledTimes(3);
      for (let i = 1; i <= 3; i++) {
        expect(execFileAsyncMock).toHaveBeenNthCalledWith(i, "xdotool", [
          "click",
          "5",
        ]);
      }
    });

    it("scrolls up with button 4 for negative scrollY", async () => {
      const result = await desktopInputTool.execute(
        { action: "scroll", scrollY: -2 },
        mockCtx,
      );
      expect(result.ok).toBe(true);
      expect(result.content).toBe("Scrolled (0, -2)");
      expect(execFileAsyncMock).toHaveBeenCalledTimes(2);
      expect(execFileAsyncMock).toHaveBeenCalledWith("xdotool", [
        "click",
        "4",
      ]);
    });

    it("ignores scrollX on Linux (only scrollY drives clicks)", async () => {
      await desktopInputTool.execute(
        { action: "scroll", scrollX: 5, scrollY: 2 },
        mockCtx,
      );
      // Only 2 clicks for scrollY=2, scrollX ignored
      expect(execFileAsyncMock).toHaveBeenCalledTimes(2);
    });

    it("produces zero clicks when scrollY=0 with non-zero scrollX on Linux", async () => {
      const result = await desktopInputTool.execute(
        { action: "scroll", scrollX: 3, scrollY: 0 },
        mockCtx,
      );
      expect(result.ok).toBe(true);
      // linuxScroll _x=3, y=0 → loop count = abs(0) = 0 → no xdotool calls
      expect(execFileAsyncMock).not.toHaveBeenCalled();
    });
  });
});

// ── Execution errors ──────────────────────────────────────────────────────────

describe("execution errors", () => {
  describe("on macOS (cliclick / osascript failure)", () => {
    beforeEach(() => {
      setPlatform("darwin");
      setupExecFailure("cliclick not installed");
    });

    it("wraps click failure as EXEC_ERROR", async () => {
      const r = await desktopInputTool.execute(
        { action: "click", x: 10, y: 20 },
        mockCtx,
      );
      expect(r.ok).toBe(false);
      expect(r.error?.code).toBe("EXEC_ERROR");
      expect(r.error?.message).toContain("Desktop input failed");
      expect(r.error?.message).toContain("cliclick not installed");
    });

    it("wraps doubleClick failure", async () => {
      const r = await desktopInputTool.execute(
        { action: "doubleClick", x: 10, y: 20 },
        mockCtx,
      );
      expect(r.ok).toBe(false);
      expect(r.error?.code).toBe("EXEC_ERROR");
    });

    it("wraps rightClick failure", async () => {
      const r = await desktopInputTool.execute(
        { action: "rightClick", x: 10, y: 20 },
        mockCtx,
      );
      expect(r.ok).toBe(false);
      expect(r.error?.code).toBe("EXEC_ERROR");
    });

    it("wraps move failure", async () => {
      const r = await desktopInputTool.execute(
        { action: "move", x: 10, y: 20 },
        mockCtx,
      );
      expect(r.ok).toBe(false);
      expect(r.error?.code).toBe("EXEC_ERROR");
    });

    it("wraps type failure (osascript error)", async () => {
      const r = await desktopInputTool.execute(
        { action: "type", text: "hello" },
        mockCtx,
      );
      expect(r.ok).toBe(false);
      expect(r.error?.code).toBe("EXEC_ERROR");
    });

    it("wraps key failure (osascript error)", async () => {
      const r = await desktopInputTool.execute(
        { action: "key", key: "return" },
        mockCtx,
      );
      expect(r.ok).toBe(false);
      expect(r.error?.code).toBe("EXEC_ERROR");
    });

    it("wraps hotkey failure (osascript error)", async () => {
      const r = await desktopInputTool.execute(
        { action: "hotkey", modifiers: ["cmd"], key: "c" },
        mockCtx,
      );
      expect(r.ok).toBe(false);
      expect(r.error?.code).toBe("EXEC_ERROR");
    });

    it("wraps scroll failure", async () => {
      const r = await desktopInputTool.execute(
        { action: "scroll", scrollY: 2 },
        mockCtx,
      );
      expect(r.ok).toBe(false);
      expect(r.error?.code).toBe("EXEC_ERROR");
    });
  });

  describe("on Linux (xdotool failure)", () => {
    beforeEach(() => {
      setPlatform("linux");
      setupExecFailure("xdotool not installed");
    });

    it("wraps click failure as EXEC_ERROR", async () => {
      const r = await desktopInputTool.execute(
        { action: "click", x: 10, y: 20 },
        mockCtx,
      );
      expect(r.ok).toBe(false);
      expect(r.error?.code).toBe("EXEC_ERROR");
      expect(r.error?.message).toContain("Desktop input failed");
      expect(r.error?.message).toContain("xdotool not installed");
    });

    it("wraps type failure", async () => {
      const r = await desktopInputTool.execute(
        { action: "type", text: "test" },
        mockCtx,
      );
      expect(r.ok).toBe(false);
      expect(r.error?.code).toBe("EXEC_ERROR");
    });

    it("wraps key failure", async () => {
      const r = await desktopInputTool.execute(
        { action: "key", key: "a" },
        mockCtx,
      );
      expect(r.ok).toBe(false);
      expect(r.error?.code).toBe("EXEC_ERROR");
    });

    it("wraps hotkey failure", async () => {
      const r = await desktopInputTool.execute(
        { action: "hotkey", modifiers: ["ctrl"], key: "c" },
        mockCtx,
      );
      expect(r.ok).toBe(false);
      expect(r.error?.code).toBe("EXEC_ERROR");
    });

    it("wraps scroll failure", async () => {
      const r = await desktopInputTool.execute(
        { action: "scroll", scrollY: 2 },
        mockCtx,
      );
      expect(r.ok).toBe(false);
      expect(r.error?.code).toBe("EXEC_ERROR");
    });
  });

  it("handles non-Error rejection value via String(e) fallback", async () => {
    // Use the key action which goes through runOsascript (no internal catch),
    // so a non-Error rejection propagates to the execute-level catch block.
    setPlatform("darwin");
    execFileAsyncMock.mockRejectedValue("raw string error");
    const r = await desktopInputTool.execute(
      { action: "key", key: "return" },
      mockCtx,
    );
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("EXEC_ERROR");
    expect(r.error?.message).toContain("Desktop input failed");
    // String(e) on a non-Error value yields the value itself
    expect(r.error?.message).toContain("raw string error");
  });
});

// ── Edge cases ─────────────────────────────────────────────────────────────────

describe("edge cases", () => {
  beforeEach(() => {
    setPlatform("darwin");
    setupExecSuccess();
  });

  it("handles very large coordinates", async () => {
    const result = await desktopInputTool.execute(
      { action: "click", x: 99999, y: -99999 },
      mockCtx,
    );
    expect(result.ok).toBe(true);
    expect(result.content).toBe("Clicked at (99999, -99999)");
  });

  it("passes through a full-featured ToolContext without crashing", async () => {
    const ctx: ToolContext = {
      cwd: "/custom/path",
      sessionId: "my-session",
      allowedPaths: ["/tmp"],
      env: { DISPLAY: ":0" },
      signal: new AbortController().signal,
      dryRun: false,
    };
    const result = await desktopInputTool.execute(
      { action: "key", key: "a" },
      ctx,
    );
    expect(result.ok).toBe(true);
  });

  it("handles zero as coordinate instead of null/undefined for click", async () => {
    // x=0 is only falsy but `x == null` only matches null/undefined
    const result = await desktopInputTool.execute(
      { action: "click", x: 0, y: 0 },
      mockCtx,
    );
    expect(result.ok).toBe(true);
  });

  it("rejects click when y is explicitly null", async () => {
    const result = await desktopInputTool.execute(
      { action: "click", x: 10, y: null as any },
      mockCtx,
    );
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain("x and y are required");
  });

  it("rejects click when y is undefined", async () => {
    const result = await desktopInputTool.execute(
      { action: "click", x: 10, y: undefined as any },
      mockCtx,
    );
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain("x and y are required");
  });
});
