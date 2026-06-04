/**
 * Tests for desktop_script tool (desktop-script.ts)
 *
 * Verifies: tool metadata, AppleScript/shell/JavaScript execution paths,
 * stdout/stderr capture, timeout handling, platform detection (darwin vs non-darwin),
 * error wrapping, renderHint metadata, and edge cases.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Hoisted mocks ──────────────────────────────────────────────────────────────

const { mockExecFile, mockExec } = vi.hoisted(() => ({
  mockExecFile: vi.fn(),
  mockExec: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execFile: mockExecFile,
  exec: mockExec,
}));

import { desktopScriptTool } from "../desktop-script.js";
import type { ToolContext } from "../types.js";

// ── mockCtx ────────────────────────────────────────────────────────────────────

const mockCtx: ToolContext = {
  cwd: "/tmp/test",
  sessionId: "test-session",
};

const ORIGINAL_PLATFORM = process.platform;

// ── Helpers ─────────────────────────────────────────────────────────────────────

/**
 * Make execFile resolve with given stdout/stderr via callback pattern.
 * The mock receives (file, args, opts, callback) — the promisify wrapper
 * resolves with the first non-error callback arg, which is the object we pass.
 */
function resolveExecFile(stdout = "output", stderr = "") {
  mockExecFile.mockImplementation(
    (_file: string, _args: string[], _opts: unknown, callback: (err: null, result: { stdout: string; stderr: string }) => void) => {
      callback(null, { stdout, stderr });
    }
  );
}

function rejectExecFile(error: unknown) {
  mockExecFile.mockImplementation(
    (_file: string, _args: string[], _opts: unknown, callback: (err: unknown, _result?: unknown) => void) => {
      callback(error);
    }
  );
}

function resolveExec(stdout = "output", stderr = "") {
  mockExec.mockImplementation(
    (_cmd: string, _opts: unknown, callback: (err: null, result: { stdout: string; stderr: string }) => void) => {
      callback(null, { stdout, stderr });
    }
  );
}

function rejectExec(error: unknown) {
  mockExec.mockImplementation(
    (_cmd: string, _opts: unknown, callback: (err: unknown, _result?: unknown) => void) => {
      callback(error);
    }
  );
}

function setPlatform(platform: NodeJS.Platform | "unknown"): void {
  Object.defineProperty(process, "platform", {
    value: platform,
    configurable: true,
    writable: true,
  });
}

/** Temporarily override process.platform for platform-specific tests. */
async function withPlatform(platform: NodeJS.Platform | "unknown", fn: () => Promise<void> | void): Promise<void> {
  const original = process.platform;
  setPlatform(platform);
  try {
    await fn();
  } finally {
    setPlatform(original);
  }
}

// ── Setup / Teardown ────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.resetAllMocks();
  setPlatform("darwin");
});

afterEach(() => {
  vi.restoreAllMocks();
  setPlatform(ORIGINAL_PLATFORM);
});

// ── Tests ────────────────────────────────────────────────────────────────────────

describe("desktopScriptTool", () => {
  // ── Metadata ──────────────────────────────────────────────────────────────────

  describe("metadata", () => {
    it("has correct name", () => {
      expect(desktopScriptTool.name).toBe("desktop_script");
    });

    it("has a non-empty description mentioning script types", () => {
      expect(desktopScriptTool.description).toBeTruthy();
      expect(desktopScriptTool.description).toMatch(/applescript|shell|javascript/i);
    });

    it("declares type and script as required parameters", () => {
      expect(desktopScriptTool.parameters).toBeDefined();
      expect(desktopScriptTool.parameters.required).toEqual(["type", "script"]);
    });

    it("declares enum for type parameter", () => {
      const props = desktopScriptTool.parameters.properties as Record<string, unknown>;
      expect((props.type as Record<string, unknown>).enum).toEqual([
        "applescript",
        "shell",
        "javascript",
      ]);
    });

    it("has high riskLevel and 60s timeout in options", () => {
      expect(desktopScriptTool.options).toEqual({
        timeoutMs: 60_000,
        riskLevel: "high",
      });
    });
  });

  // ── execute — AppleScript ─────────────────────────────────────────────────────

  describe("execute — applescript", () => {
    it("returns stdout on success", async () => {
      resolveExecFile("Finder activated");
      const result = await desktopScriptTool.execute(
        { type: "applescript", script: 'tell app "Finder" to activate' },
        mockCtx
      );
      expect(result.ok).toBe(true);
      expect(result.content).toBe("Finder activated");
      expect(mockExecFile).toHaveBeenCalledWith(
        "osascript",
        ["-e", 'tell app "Finder" to activate'],
        expect.objectContaining({ timeout: 30_000, maxBuffer: 1024 * 1024 }),
        expect.any(Function)
      );
    });

    it("includes stderr in output when present (whitespace-trimmed)", async () => {
      resolveExecFile("  activated  ", "  warning: deprecated API  ");
      const result = await desktopScriptTool.execute(
        { type: "applescript", script: "x" },
        mockCtx
      );
      expect(result.ok).toBe(true);
      expect(result.content).toBe("stdout: activated\nstderr: warning: deprecated API");
    });

    it('returns "(no output)" when stdout is empty and no stderr', async () => {
      resolveExecFile("", "");
      const result = await desktopScriptTool.execute(
        { type: "applescript", script: "" },
        mockCtx
      );
      expect(result.ok).toBe(true);
      expect(result.content).toBe("(no output)");
    });

    it('returns "(no output)" when stdout is whitespace-only and no stderr', async () => {
      resolveExecFile("   ", "");
      const result = await desktopScriptTool.execute(
        { type: "applescript", script: "   " },
        mockCtx
      );
      expect(result.ok).toBe(true);
      expect(result.content).toBe("(no output)");
    });

    it("returns error result on execFile failure", async () => {
      rejectExecFile(new Error("osascript: command not found"));
      const result = await desktopScriptTool.execute(
        { type: "applescript", script: "bad" },
        mockCtx
      );
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("EXEC_ERROR");
      expect(result.content).toContain("Script execution failed:");
      expect(result.content).toContain("osascript: command not found");
    });

    it("returns error on non-darwin platform (linux)", async () => {
      await withPlatform("linux", async () => {
        const result = await desktopScriptTool.execute(
          { type: "applescript", script: "tell app" },
          mockCtx
        );
        expect(result.ok).toBe(false);
        expect(result.error?.code).toBe("EXEC_ERROR");
        expect(result.content).toContain("only supported on macOS");
        // execFile should NOT have been called (platform check fails early)
        expect(mockExecFile).not.toHaveBeenCalled();
      });
    });

    it("returns error on non-darwin platform (unknown)", async () => {
      await withPlatform("unknown", async () => {
        const result = await desktopScriptTool.execute(
          { type: "applescript", script: "tell app" },
          mockCtx
        );
        expect(result.ok).toBe(false);
        expect(result.content).toContain("only supported on macOS");
      });
    });

    it("respects custom timeout", async () => {
      resolveExecFile("done");
      await desktopScriptTool.execute(
        { type: "applescript", script: "x", timeout: 10_000 },
        mockCtx
      );
      expect(mockExecFile).toHaveBeenCalledWith(
        "osascript",
        ["-e", "x"],
        expect.objectContaining({ timeout: 10_000 }),
        expect.any(Function)
      );
    });

    it("passes maxBuffer option to execFile", async () => {
      resolveExecFile("ok");
      await desktopScriptTool.execute(
        { type: "applescript", script: "x" },
        mockCtx
      );
      expect(mockExecFile).toHaveBeenCalledWith(
        "osascript",
        ["-e", "x"],
        expect.objectContaining({ maxBuffer: 1024 * 1024 }),
        expect.any(Function)
      );
    });
  });

  // ── execute — Shell ───────────────────────────────────────────────────────────

  describe("execute — shell", () => {
    it("returns stdout on success", async () => {
      resolveExec("hello world");
      const result = await desktopScriptTool.execute(
        { type: "shell", script: "echo hello" },
        mockCtx
      );
      expect(result.ok).toBe(true);
      expect(result.content).toBe("hello world");
    });

    it("includes stderr in output when present", async () => {
      resolveExec("output", "error message");
      const result = await desktopScriptTool.execute(
        { type: "shell", script: "cmd" },
        mockCtx
      );
      expect(result.ok).toBe(true);
      expect(result.content).toBe("stdout: output\nstderr: error message");
    });

    it('returns "(no output)" when stdout is empty and no stderr', async () => {
      resolveExec("", "");
      const result = await desktopScriptTool.execute(
        { type: "shell", script: "" },
        mockCtx
      );
      expect(result.ok).toBe(true);
      expect(result.content).toBe("(no output)");
    });

    it("returns error result on exec failure", async () => {
      rejectExec(new Error("command not found: foo"));
      const result = await desktopScriptTool.execute(
        { type: "shell", script: "foo" },
        mockCtx
      );
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("EXEC_ERROR");
      expect(result.content).toContain("Script execution failed: command not found: foo");
    });

    it("passes cwd from args when provided", async () => {
      resolveExec("ok");
      await desktopScriptTool.execute(
        { type: "shell", script: "pwd", cwd: "/custom/dir" },
        mockCtx
      );
      expect(mockExec).toHaveBeenCalledWith(
        "pwd",
        expect.objectContaining({ cwd: "/custom/dir" }),
        expect.any(Function)
      );
    });

    it("falls back to ctx.cwd when args.cwd is not provided", async () => {
      resolveExec("ok");
      await desktopScriptTool.execute(
        { type: "shell", script: "pwd" },
        mockCtx
      );
      expect(mockExec).toHaveBeenCalledWith(
        "pwd",
        expect.objectContaining({ cwd: "/tmp/test" }),
        expect.any(Function)
      );
    });

    it("passes env from args merged with process.env", async () => {
      resolveExec("ok");
      await desktopScriptTool.execute(
        { type: "shell", script: "env", env: { FOO: "bar" } },
        mockCtx
      );
      const callOpts = mockExec.mock.calls[0][1] as Record<string, unknown>;
      expect(callOpts.env).toBeDefined();
      expect(callOpts.env).toMatchObject({ FOO: "bar" });
      // Should also contain existing process.env keys
      expect(callOpts.env).toHaveProperty("PATH");
    });

    it("does not set env property when args.env is not provided", async () => {
      resolveExec("ok");
      await desktopScriptTool.execute(
        { type: "shell", script: "pwd" },
        mockCtx
      );
      const callOpts = mockExec.mock.calls[0][1] as Record<string, unknown>;
      expect(callOpts.env).toBeUndefined();
    });

    it("respects custom timeout", async () => {
      resolveExec("ok");
      await desktopScriptTool.execute(
        { type: "shell", script: "sleep 1", timeout: 5_000 },
        mockCtx
      );
      expect(mockExec).toHaveBeenCalledWith(
        "sleep 1",
        expect.objectContaining({ timeout: 5_000 }),
        expect.any(Function)
      );
    });

    it("passes maxBuffer option", async () => {
      resolveExec("ok");
      await desktopScriptTool.execute(
        { type: "shell", script: "cat bigfile" },
        mockCtx
      );
      expect(mockExec).toHaveBeenCalledWith(
        "cat bigfile",
        expect.objectContaining({ maxBuffer: 1024 * 1024 }),
        expect.any(Function)
      );
    });

    it("works on any platform (not restricted to darwin)", async () => {
      // Shell execution has no platform check — should work everywhere
      await withPlatform("linux", async () => {
        resolveExec("linux output");
        const result = await desktopScriptTool.execute(
          { type: "shell", script: "uname" },
          mockCtx
        );
        expect(result.ok).toBe(true);
        expect(result.content).toBe("linux output");
      });
    });
  });

  // ── execute — JavaScript ──────────────────────────────────────────────────────

  describe("execute — javascript", () => {
    it("returns stdout on success", async () => {
      resolveExecFile("UI element found");
      const result = await desktopScriptTool.execute(
        { type: "javascript", script: 'Application("System Events").processes()' },
        mockCtx
      );
      expect(result.ok).toBe(true);
      expect(result.content).toBe("UI element found");
      expect(mockExecFile).toHaveBeenCalledWith(
        "osascript",
        ["-l", "JavaScript", "-e", 'Application("System Events").processes()'],
        expect.objectContaining({ timeout: 30_000, maxBuffer: 1024 * 1024 }),
        expect.any(Function)
      );
    });

    it("includes stderr in output when present", async () => {
      resolveExecFile("output", "warning");
      const result = await desktopScriptTool.execute(
        { type: "javascript", script: "x" },
        mockCtx
      );
      expect(result.ok).toBe(true);
      expect(result.content).toContain("stdout: output");
      expect(result.content).toContain("stderr: warning");
    });

    it('returns "(no output)" when stdout is empty and no stderr', async () => {
      resolveExecFile("", "");
      const result = await desktopScriptTool.execute(
        { type: "javascript", script: "" },
        mockCtx
      );
      expect(result.ok).toBe(true);
      expect(result.content).toBe("(no output)");
    });

    it("returns error result on execFile failure", async () => {
      rejectExecFile(new Error("osascript not found"));
      const result = await desktopScriptTool.execute(
        { type: "javascript", script: "bad" },
        mockCtx
      );
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("EXEC_ERROR");
      expect(result.content).toContain("Script execution failed: osascript not found");
    });

    it("returns error on non-darwin platform (linux)", async () => {
      await withPlatform("linux", async () => {
        const result = await desktopScriptTool.execute(
          { type: "javascript", script: "..." },
          mockCtx
        );
        expect(result.ok).toBe(false);
        expect(result.error?.code).toBe("EXEC_ERROR");
        expect(result.content).toContain("only supported on macOS");
        expect(mockExecFile).not.toHaveBeenCalled();
      });
    });

    it("returns error on non-darwin platform (unknown)", async () => {
      await withPlatform("unknown", async () => {
        const result = await desktopScriptTool.execute(
          { type: "javascript", script: "..." },
          mockCtx
        );
        expect(result.ok).toBe(false);
        expect(result.content).toContain("only supported on macOS");
      });
    });

    it("passes -l JavaScript flag to osascript", async () => {
      resolveExecFile("ok");
      await desktopScriptTool.execute(
        { type: "javascript", script: "true" },
        mockCtx
      );
      expect(mockExecFile).toHaveBeenCalledWith(
        "osascript",
        expect.arrayContaining(["-l", "JavaScript"]),
        expect.any(Object),
        expect.any(Function)
      );
    });
  });

  // ── execute — Edge cases & error handling ─────────────────────────────────────

  describe("execute — edge cases", () => {
    it("returns UNKNOWN error for invalid script type", async () => {
      const result = await desktopScriptTool.execute(
        { type: "invalid_type" as unknown as "applescript", script: "..." },
        mockCtx
      );
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("UNKNOWN");
      expect(result.content).toContain("Unknown script type: invalid_type");
      // Should not call execFile or exec
      expect(mockExecFile).not.toHaveBeenCalled();
      expect(mockExec).not.toHaveBeenCalled();
    });

    it("handles non-Error thrown values (e.g. string)", async () => {
      // Reject with a string instead of Error
      rejectExecFile("raw string error");
      const result = await desktopScriptTool.execute(
        { type: "applescript", script: "x" },
        mockCtx
      );
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("EXEC_ERROR");
      expect(result.content).toBe("Script execution failed: raw string error");
    });

    it("defaults timeout to 30_000 when not specified", async () => {
      resolveExecFile("ok");
      await desktopScriptTool.execute(
        { type: "applescript", script: "x" },
        mockCtx
      );
      expect(mockExecFile).toHaveBeenCalledWith(
        "osascript",
        ["-e", "x"],
        expect.objectContaining({ timeout: 30_000 }),
        expect.any(Function)
      );
    });

    it("defaults timeout to 30_000 when undefined is explicitly passed", async () => {
      resolveExec("ok");
      await desktopScriptTool.execute(
        { type: "shell", script: "x", timeout: undefined as unknown as number },
        mockCtx
      );
      expect(mockExec).toHaveBeenCalledWith(
        "x",
        expect.objectContaining({ timeout: 30_000 }),
        expect.any(Function)
      );
    });

    it("returns renderHint code/bash for shell type", async () => {
      resolveExec("ok");
      const result = await desktopScriptTool.execute(
        { type: "shell", script: "ls" },
        mockCtx
      );
      expect(result.metadata?.renderHint).toEqual({ type: "code", lang: "bash" });
    });

    it("returns renderHint code/applescript for applescript type", async () => {
      resolveExecFile("ok");
      const result = await desktopScriptTool.execute(
        { type: "applescript", script: "x" },
        mockCtx
      );
      expect(result.metadata?.renderHint).toEqual({ type: "code", lang: "applescript" });
    });

    it("returns renderHint code/javascript for javascript type", async () => {
      resolveExecFile("ok");
      const result = await desktopScriptTool.execute(
        { type: "javascript", script: "x" },
        mockCtx
      );
      expect(result.metadata?.renderHint).toEqual({ type: "code", lang: "javascript" });
    });

    it("returns EXEC_ERROR with wrapped message on failure", async () => {
      rejectExecFile(new Error("ENOENT: no such file or directory, open '/nonexistent'"));
      const result = await desktopScriptTool.execute(
        { type: "applescript", script: "x" },
        mockCtx
      );
      expect(result.ok).toBe(false);
      expect(result.error).toEqual({
        code: "EXEC_ERROR",
        message: "Script execution failed: ENOENT: no such file or directory, open '/nonexistent'",
        retryable: false,
      });
    });
  });
});
