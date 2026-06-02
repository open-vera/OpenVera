/**
 * Tests for bash tool (bash.ts)
 *
 * Verifies: tool metadata, successful command execution (stdout/stderr capture),
 * execution timeout, command failure (non-zero exit), abort signal handling,
 * spawn errors, process errors, output truncation, and edge cases.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import type { ToolContext } from "../types.js";

// ── Mocks ──────────────────────────────────────────────────────────────────────

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

vi.mock("../utils/truncate.js", () => ({
  truncateChars: vi.fn(),
}));

// ── Globals set up in beforeEach ────────────────────────────────────────────────

let mockSpawn: ReturnType<typeof vi.fn>;
let mockTruncateChars: ReturnType<typeof vi.fn>;

const TEST_PID = 12345;

interface MockChildInternals {
  stdout: EventEmitter;
  stderr: EventEmitter;
  pid: number;
  _listeners: Record<string, ((...args: unknown[]) => void)[]>;
}

function createMockChild(pid = TEST_PID): MockChildInternals {
  const listeners: Record<string, ((...args: unknown[]) => void)[]> = {};
  return {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    pid,
    _listeners: listeners,
  };
}

/**
 * Wire spawn to return a child-like object built from MockChildInternals.
 * Returns the internal handle so tests can emit events.
 */
function wireMockChild(mockChild?: MockChildInternals): MockChildInternals {
  const child = mockChild ?? createMockChild();
  mockSpawn.mockReturnValue({
    stdout: child.stdout,
    stderr: child.stderr,
    pid: child.pid,
    on(event: string, handler: (...args: unknown[]) => void) {
      if (!child._listeners[event]) child._listeners[event] = [];
      child._listeners[event].push(handler);
      return this;
    },
  } as unknown as ReturnType<typeof mockSpawn>);
  return child;
}

function emitChildEvent(child: MockChildInternals, event: string, ...args: unknown[]) {
  const handlers = child._listeners[event] ?? [];
  for (const h of handlers) h(...args);
}

// ── mockCtx ────────────────────────────────────────────────────────────────────

const mockCtx: ToolContext = {
  cwd: "/tmp/test",
  sessionId: "test-session",
};

// ── Setup / Teardown ────────────────────────────────────────────────────────────

beforeEach(async () => {
  vi.resetAllMocks();
  vi.spyOn(process, "kill").mockImplementation(() => true);

  // Store typed references to mocked functions
  const childProcess = await import("node:child_process");
  mockSpawn = vi.mocked(childProcess.spawn);

  const truncateModule = await import("../utils/truncate.js");
  mockTruncateChars = vi.mocked(truncateModule.truncateChars);
  mockTruncateChars.mockImplementation((text: string) => ({
    content: text,
    truncated: false,
  }));
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function loadTool() {
  return (await import("../bash.js")).bashTool;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Tool metadata
// ═══════════════════════════════════════════════════════════════════════════════

describe("bash tool metadata", () => {
  it("has name 'bash'", async () => {
    const tool = await loadTool();
    expect(tool.name).toBe("bash");
  });

  it("description mentions shell command execution", async () => {
    const tool = await loadTool();
    expect(tool.description).toContain("shell command");
    expect(tool.description).toContain("stdout");
    expect(tool.description).toContain("stderr");
    expect(tool.description).toContain("exit code");
  });

  it("parameters require 'command'", async () => {
    const tool = await loadTool();
    expect(tool.parameters.required).toEqual(["command"]);
  });

  it("parameters define 'command' as string and 'timeout' as optional number", async () => {
    const tool = await loadTool();
    const props = tool.parameters.properties as Record<string, unknown>;
    expect(props.command).toEqual({
      type: "string",
      description: "Shell command to execute",
    });
    expect(props.timeout).toEqual({
      type: "number",
      description: "Timeout in milliseconds (default 30000)",
    });
  });

  it("has riskLevel 'high' and timeoutMs 35000", async () => {
    const tool = await loadTool();
    expect(tool.options?.riskLevel).toBe("high");
    expect(tool.options?.timeoutMs).toBe(35_000);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Successful execution
// ═══════════════════════════════════════════════════════════════════════════════

describe("bash execute — success", () => {
  it("executes a command and returns stdout", async () => {
    const child = wireMockChild();
    const tool = await loadTool();

    const promise = tool.execute({ command: "echo hello" }, mockCtx);

    child.stdout.emit("data", "hello\n");
    emitChildEvent(child, "close", 0, null);

    const result = await promise;
    expect(result.ok).toBe(true);
    expect(result.content).toBe("hello\n");
    expect(result.metadata?.exitCode).toBe(0);
    expect(result.metadata?.truncated).toBe(false);
    expect(result.metadata?.renderHint).toEqual({
      type: "bash-output",
      exitCode: 0,
    });
  });

  it("captures stderr separately and combines output", async () => {
    const child = wireMockChild();
    const tool = await loadTool();

    const promise = tool.execute({ command: "ls /nonexistent" }, mockCtx);

    child.stderr.emit("data", "ls: cannot access /nonexistent: No such file or directory\n");
    emitChildEvent(child, "close", 2, null);

    const result = await promise;
    expect(result.ok).toBe(true);
    expect(result.content).toContain("cannot access");
    expect(result.metadata?.exitCode).toBe(2);
  });

  it("returns (no output) when both stdout and stderr are empty", async () => {
    const child = wireMockChild();
    const tool = await loadTool();

    const promise = tool.execute({ command: "true" }, mockCtx);

    emitChildEvent(child, "close", 0, null);

    const result = await promise;
    expect(result.ok).toBe(true);
    expect(result.content).toBe("(no output)");
    expect(result.metadata?.exitCode).toBe(0);
  });

  it("calls ctx.onOutput for each stdout chunk", async () => {
    const child = wireMockChild();
    const tool = await loadTool();
    const onOutput = vi.fn();

    const promise = tool.execute(
      { command: "echo hi" },
      { ...mockCtx, onOutput }
    );

    child.stdout.emit("data", "chunk1");
    child.stdout.emit("data", "chunk2");
    emitChildEvent(child, "close", 0, null);

    await promise;
    expect(onOutput).toHaveBeenCalledTimes(2);
    expect(onOutput).toHaveBeenCalledWith("chunk1");
    expect(onOutput).toHaveBeenCalledWith("chunk2");
  });

  it("calls ctx.onOutput for stderr chunks", async () => {
    const child = wireMockChild();
    const tool = await loadTool();
    const onOutput = vi.fn();

    const promise = tool.execute(
      { command: "echo hi >&2" },
      { ...mockCtx, onOutput }
    );

    child.stderr.emit("data", "error output");
    emitChildEvent(child, "close", 0, null);

    await promise;
    expect(onOutput).toHaveBeenCalledWith("error output");
  });

  it("handles Buffer chunks (binary stdout)", async () => {
    const child = wireMockChild();
    const tool = await loadTool();

    const promise = tool.execute({ command: "cat binary" }, mockCtx);

    child.stdout.emit("data", Buffer.from("binary-data", "utf8"));
    emitChildEvent(child, "close", 0, null);

    const result = await promise;
    expect(result.ok).toBe(true);
    expect(result.content).toContain("binary-data");
  });

  it("combines stdout and stderr separated by newline", async () => {
    const child = wireMockChild();
    const tool = await loadTool();

    const promise = tool.execute({ command: "cmd" }, mockCtx);

    child.stdout.emit("data", "stdout line");
    child.stderr.emit("data", "stderr line");
    emitChildEvent(child, "close", 0, null);

    const result = await promise;
    expect(result.content).toContain("stdout line");
    expect(result.content).toContain("stderr line");
  });

  it("only includes stdout in output when stderr is empty", async () => {
    const child = wireMockChild();
    const tool = await loadTool();

    const promise = tool.execute({ command: "cmd" }, mockCtx);

    child.stdout.emit("data", "output only");
    emitChildEvent(child, "close", 0, null);

    const result = await promise;
    expect(result.content).toBe("output only");
  });

  it("only includes stderr in output when stdout is empty", async () => {
    const child = wireMockChild();
    const tool = await loadTool();

    const promise = tool.execute({ command: "cmd" }, mockCtx);

    child.stderr.emit("data", "error only");
    emitChildEvent(child, "close", 0, null);

    const result = await promise;
    expect(result.content).toBe("error only");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Spawn arguments
// ═══════════════════════════════════════════════════════════════════════════════

describe("bash execute — spawn arguments", () => {
  it("spawns 'bash' with '-c' and the command", async () => {
    const child = wireMockChild();
    const tool = await loadTool();

    const promise = tool.execute({ command: "echo test" }, mockCtx);
    emitChildEvent(child, "close", 0, null);
    await promise;

    expect(mockSpawn).toHaveBeenCalledWith("bash", ["-c", "echo test"], expect.any(Object));
  });

  it("passes cwd from context", async () => {
    const child = wireMockChild();
    const tool = await loadTool();

    const promise = tool.execute(
      { command: "pwd" },
      { ...mockCtx, cwd: "/custom/dir" }
    );
    emitChildEvent(child, "close", 0, null);
    await promise;

    expect(mockSpawn).toHaveBeenCalledWith(
      "bash",
      ["-c", "pwd"],
      expect.objectContaining({ cwd: "/custom/dir" })
    );
  });

  it("merges ctx.env with process.env", async () => {
    const child = wireMockChild();
    const tool = await loadTool();

    const promise = tool.execute(
      { command: "env" },
      { ...mockCtx, env: { MY_VAR: "my_value" } }
    );
    emitChildEvent(child, "close", 0, null);
    await promise;

    const [_cmd, _args, opts] = mockSpawn.mock.calls[0] as [string, string[], Record<string, unknown>];
    expect(opts.env).toHaveProperty("MY_VAR", "my_value");
    expect(opts.env).toHaveProperty("PATH");
  });

  it("sets stdio to ['ignore', 'pipe', 'pipe'] and detached true", async () => {
    const child = wireMockChild();
    const tool = await loadTool();

    const promise = tool.execute({ command: "ls" }, mockCtx);
    emitChildEvent(child, "close", 0, null);
    await promise;

    expect(mockSpawn).toHaveBeenCalledWith(
      "bash",
      expect.any(Array),
      expect.objectContaining({
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      })
    );
  });

  it("does not include custom env when ctx.env is undefined", async () => {
    const child = wireMockChild();
    const tool = await loadTool();

    const promise = tool.execute(
      { command: "ls" },
      { cwd: "/tmp", sessionId: "s" }
    );
    emitChildEvent(child, "close", 0, null);
    await promise;

    const [_cmd, _args, opts] = mockSpawn.mock.calls[0] as [string, string[], Record<string, unknown>];
    expect(opts.env).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Timeout handling
// ═══════════════════════════════════════════════════════════════════════════════

describe("bash execute — timeout", () => {
  it("returns TIMEOUT error when command exceeds the specified timeout", async () => {
    vi.useFakeTimers();
    const child = wireMockChild();
    const tool = await loadTool();

    const promise = tool.execute({ command: "sleep 100", timeout: 500 }, mockCtx);

    // Advance past the timeout — setTimeout fires, killReason = "timeout"
    vi.advanceTimersByTime(501);

    // Emit close so the close handler resolves the promise
    emitChildEvent(child, "close", null, "SIGTERM");

    vi.useRealTimers();
    const result = await promise;
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("TIMEOUT");
    expect(result.content).toContain("timed out after 500ms");
    expect(result.content).toContain("sleep 100");
  });

  it("uses default timeout of 30s when not specified", async () => {
    vi.useFakeTimers();
    const child = wireMockChild();
    const tool = await loadTool();

    const promise = tool.execute({ command: "sleep 100" }, mockCtx);

    // Default is 30000ms — advancing past that triggers timeout
    vi.advanceTimersByTime(30_001);

    emitChildEvent(child, "close", null, "SIGTERM");

    vi.useRealTimers();
    const result = await promise;
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("TIMEOUT");
    expect(result.content).toContain("timed out after 30000ms");
  });

  it("clears the timeout timer when command finishes before timeout", async () => {
    vi.useFakeTimers();
    const child = wireMockChild();
    const tool = await loadTool();

    const promise = tool.execute({ command: "echo fast", timeout: 10000 }, mockCtx);

    // Command finishes fast (before 10000ms)
    child.stdout.emit("data", "fast\n");
    emitChildEvent(child, "close", 0, null);

    vi.useRealTimers();
    const result = await promise;
    expect(result.ok).toBe(true);
    expect(result.content).toBe("fast\n");
  });

  it("calls process.kill with negative pid on timeout", async () => {
    vi.useFakeTimers();
    const child = wireMockChild();
    const tool = await loadTool();

    const promise = tool.execute({ command: "sleep 100", timeout: 100 }, mockCtx);

    vi.advanceTimersByTime(101);

    expect(process.kill).toHaveBeenCalledWith(-TEST_PID, "SIGTERM");

    // Emit close so the promise resolves
    emitChildEvent(child, "close", null, "SIGTERM");

    vi.useRealTimers();
    const result = await promise;
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("TIMEOUT");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// AbortSignal handling
// ═══════════════════════════════════════════════════════════════════════════════

describe("bash execute — abort", () => {
  it("returns UNKNOWN error when AbortSignal fires", async () => {
    const child = wireMockChild();
    const tool = await loadTool();
    const controller = new AbortController();

    const promise = tool.execute(
      { command: "sleep 100" },
      { ...mockCtx, signal: controller.signal }
    );

    // Abort triggers killReason = "abort"
    controller.abort();
    // close fires after kill → handler sees killReason === "abort"
    emitChildEvent(child, "close", null, "SIGTERM");

    const result = await promise;
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("UNKNOWN");
    expect(result.content).toBe("Command was aborted");
  });

  it("calls process.kill on abort", async () => {
    const child = wireMockChild();
    const tool = await loadTool();
    const controller = new AbortController();

    const promise = tool.execute(
      { command: "sleep 100" },
      { ...mockCtx, signal: controller.signal }
    );

    controller.abort();

    expect(process.kill).toHaveBeenCalledWith(-TEST_PID, "SIGTERM");

    emitChildEvent(child, "close", null, "SIGTERM");
    await promise;
  });

  it("removes abort listener on normal completion", async () => {
    const child = wireMockChild();
    const tool = await loadTool();
    const controller = new AbortController();
    const removeSpy = vi.spyOn(controller.signal, "removeEventListener");

    const promise = tool.execute(
      { command: "echo ok" },
      { ...mockCtx, signal: controller.signal }
    );

    child.stdout.emit("data", "ok\n");
    emitChildEvent(child, "close", 0, null);

    await promise;
    expect(removeSpy).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("does not fail when ctx.signal is undefined", async () => {
    const child = wireMockChild();
    const tool = await loadTool();

    const promise = tool.execute(
      { command: "echo ok" },
      { cwd: "/tmp", sessionId: "s" }
    );

    child.stdout.emit("data", "ok\n");
    emitChildEvent(child, "close", 0, null);

    const result = await promise;
    expect(result.ok).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Error handling
// ═══════════════════════════════════════════════════════════════════════════════

describe("bash execute — errors", () => {
  it("returns UNKNOWN when spawn throws synchronously", async () => {
    mockSpawn.mockImplementation(() => {
      throw new Error("bash not found");
    });
    const tool = await loadTool();

    const result = await tool.execute({ command: "echo hi" }, mockCtx);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("UNKNOWN");
    expect(result.content).toContain("Failed to spawn process");
    expect(result.content).toContain("bash not found");
  });

  it("returns UNKNOWN when spawn throws a non-Error value", async () => {
    mockSpawn.mockImplementation(() => {
      throw "something went wrong";
    });
    const tool = await loadTool();

    const result = await tool.execute({ command: "echo hi" }, mockCtx);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("UNKNOWN");
    expect(result.content).toContain("something went wrong");
  });

  it("returns UNKNOWN when child process emits 'error'", async () => {
    const child = wireMockChild();
    const tool = await loadTool();

    const promise = tool.execute({ command: "nonexistent_cmd" }, mockCtx);

    emitChildEvent(child, "error", new Error("ENOENT: command not found"));

    const result = await promise;
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("UNKNOWN");
    expect(result.content).toContain("Process error");
    expect(result.content).toContain("ENOENT");
  });

  it("clears timeout and removes abort listener on process error", async () => {
    const child = wireMockChild();
    const tool = await loadTool();
    const controller = new AbortController();
    const removeSpy = vi.spyOn(controller.signal, "removeEventListener");

    const promise = tool.execute(
      { command: "bad-cmd" },
      { ...mockCtx, signal: controller.signal }
    );

    emitChildEvent(child, "error", new Error("spawn failed"));

    await promise;
    expect(removeSpy).toHaveBeenCalledWith("abort", expect.any(Function));
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Non-zero exit code
// ═══════════════════════════════════════════════════════════════════════════════

describe("bash execute — non-zero exit", () => {
  it("returns ok: true on non-zero exit code", async () => {
    const child = wireMockChild();
    const tool = await loadTool();

    const promise = tool.execute({ command: "exit 1" }, mockCtx);

    child.stderr.emit("data", "something failed\n");
    emitChildEvent(child, "close", 1, null);

    const result = await promise;
    expect(result.ok).toBe(true);
    expect(result.metadata?.exitCode).toBe(1);
    expect(result.metadata?.renderHint).toEqual({
      type: "bash-output",
      exitCode: 1,
    });
  });

  it("returns the actual exit code from close event", async () => {
    const child = wireMockChild();
    const tool = await loadTool();

    const promise = tool.execute({ command: "exit 42" }, mockCtx);

    emitChildEvent(child, "close", 42, null);

    const result = await promise;
    expect(result.metadata?.exitCode).toBe(42);
  });

  it("uses exit code 137 when exitCode is null and signal is SIGTERM", async () => {
    const child = wireMockChild();
    const tool = await loadTool();

    const promise = tool.execute({ command: "sleep 1" }, mockCtx);

    emitChildEvent(child, "close", null, "SIGTERM");

    const result = await promise;
    expect(result.ok).toBe(true);
    expect(result.metadata?.exitCode).toBe(137);
  });

  it("uses exit code 1 when exitCode is null and signal is not SIGTERM", async () => {
    const child = wireMockChild();
    const tool = await loadTool();

    const promise = tool.execute({ command: "sleep 1" }, mockCtx);

    emitChildEvent(child, "close", null, "SIGKILL");

    const result = await promise;
    expect(result.ok).toBe(true);
    expect(result.metadata?.exitCode).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Output truncation
// ═══════════════════════════════════════════════════════════════════════════════

describe("bash execute — truncation", () => {
  it("truncates via truncateChars when combined output > 80K chars", async () => {
    const child = wireMockChild();
    const tool = await loadTool();

    mockTruncateChars.mockReturnValue({
      content: "first 80K chars...",
      truncated: true,
    });

    const promise = tool.execute({ command: "cat huge.log" }, mockCtx);

    child.stdout.emit("data", "x".repeat(100_000));
    emitChildEvent(child, "close", 0, null);

    const result = await promise;
    expect(result.ok).toBe(true);
    expect(result.content).toBe("first 80K chars...");
    expect(result.metadata?.truncated).toBe(true);
  });

  it("kills process when stdout exceeds 512KB streaming limit", async () => {
    const child = wireMockChild();
    const tool = await loadTool();

    const promise = tool.execute({ command: "yes" }, mockCtx);

    // Emit more than 512KB (524288 bytes) to trigger the streaming output limit
    child.stdout.emit("data", "x".repeat(524289));

    expect(process.kill).toHaveBeenCalledWith(-TEST_PID, "SIGTERM");

    emitChildEvent(child, "close", null, "SIGTERM");

    const result = await promise;
    expect(result.ok).toBe(true);
    expect(result.metadata?.truncated).toBe(true);
    expect(result.content).toContain("output exceeded 512KB limit");
    expect(result.content).toContain("terminated early");
  });

  it("kills process when stderr exceeds 512KB streaming limit", async () => {
    const child = wireMockChild();
    const tool = await loadTool();

    const promise = tool.execute({ command: "verbose-cmd" }, mockCtx);

    child.stderr.emit("data", "x".repeat(524289));

    expect(process.kill).toHaveBeenCalledWith(-TEST_PID, "SIGTERM");

    emitChildEvent(child, "close", null, "SIGTERM");

    const result = await promise;
    expect(result.ok).toBe(true);
    expect(result.metadata?.truncated).toBe(true);
  });

  it("does not add streaming truncation message when char truncation also applies", async () => {
    const child = wireMockChild();
    const tool = await loadTool();

    // When both streaming and char truncation happen, the streaming message
    // is suppressed (code checks streamTruncated && !charsTruncated)
    mockTruncateChars.mockReturnValue({
      content: "truncated output",
      truncated: true,
    });

    const promise = tool.execute({ command: "yes" }, mockCtx);

    child.stdout.emit("data", "x".repeat(524289));
    emitChildEvent(child, "close", null, "SIGTERM");

    const result = await promise;
    expect(result.metadata?.truncated).toBe(true);
    expect(result.content).not.toContain("terminated early");
    expect(result.content).toBe("truncated output");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Edge cases
// ═══════════════════════════════════════════════════════════════════════════════

describe("bash execute — edge cases", () => {
  it("handles empty command string", async () => {
    const child = wireMockChild();
    const tool = await loadTool();

    const promise = tool.execute({ command: "" }, mockCtx);

    emitChildEvent(child, "close", 0, null);

    const result = await promise;
    expect(result.ok).toBe(true);
    expect(result.content).toBe("(no output)");
    expect(result.metadata?.exitCode).toBe(0);
  });

  it("handles command with special characters", async () => {
    const child = wireMockChild();
    const tool = await loadTool();

    const promise = tool.execute(
      { command: "echo 'hello $USER' && printf 'line1\nline2'" },
      mockCtx
    );

    child.stdout.emit("data", "hello $USER\nline1\nline2");
    emitChildEvent(child, "close", 0, null);

    const result = await promise;
    expect(result.ok).toBe(true);
    expect(result.content).toContain("hello");
    expect(result.content).toContain("line1");
    expect(result.content).toContain("line2");
  });

  it("handles mixed Buffer and string chunks", async () => {
    const child = wireMockChild();
    const tool = await loadTool();

    const promise = tool.execute({ command: "mixed-output" }, mockCtx);

    child.stdout.emit("data", "string part ");
    child.stdout.emit("data", Buffer.from("buffer part\n", "utf8"));
    emitChildEvent(child, "close", 0, null);

    const result = await promise;
    expect(result.ok).toBe(true);
    expect(result.content).toContain("string part");
    expect(result.content).toContain("buffer part");
  });

  it("does not crash when child.pid is undefined in killProcessGroup", async () => {
    // Create child with undefined pid — killProcessGroup checks pid != null and returns early
    const childNoPid = createMockChild(undefined as unknown as number);
    wireMockChild(childNoPid);
    const tool = await loadTool();

    const promise = tool.execute({ command: "echo ok" }, mockCtx);

    childNoPid.stdout.emit("data", "ok\n");
    emitChildEvent(childNoPid, "close", 0, null);

    const result = await promise;
    expect(result.ok).toBe(true);
  });

  it("includes combined stdout and stderr even after non-zero exit", async () => {
    const child = wireMockChild();
    const tool = await loadTool();

    const promise = tool.execute({ command: "failing-cmd" }, mockCtx);

    child.stdout.emit("data", "partial output\n");
    child.stderr.emit("data", "error details\n");
    emitChildEvent(child, "close", 1, null);

    const result = await promise;
    expect(result.ok).toBe(true);
    expect(result.content).toContain("partial output");
    expect(result.content).toContain("error details");
    expect(result.metadata?.exitCode).toBe(1);
  });

  it("has correct metadata shape for successful execution", async () => {
    const child = wireMockChild();
    const tool = await loadTool();

    const promise = tool.execute({ command: "echo ok" }, mockCtx);

    child.stdout.emit("data", "ok\n");
    emitChildEvent(child, "close", 0, null);

    const result = await promise;
    expect(result.ok).toBe(true);
    expect(result.metadata).toBeDefined();
    expect(result.metadata).toHaveProperty("exitCode");
    expect(result.metadata).toHaveProperty("truncated");
    expect(result.metadata).toHaveProperty("renderHint");
    expect(result.error).toBeUndefined();
  });
});
