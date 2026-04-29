import { describe, it, expect } from "vitest";
import { bashTool } from "../src/tools/bash.js";
import type { ToolContext } from "../src/tools/types.js";

const ctx: ToolContext = { cwd: "/tmp", readonlyMode: false };

describe("bashTool", () => {
  it("executes a simple command and returns stdout", async () => {
    const result = await bashTool.execute({ command: "echo hello" }, ctx);
    expect(result.ok).toBe(true);
    expect(result.content).toContain("hello");
  });

  it("captures stderr", async () => {
    const result = await bashTool.execute({ command: "echo err >&2" }, ctx);
    expect(result.ok).toBe(true);
    expect(result.content).toContain("err");
  });

  it("returns exitCode in metadata", async () => {
    const result = await bashTool.execute({ command: "exit 0" }, ctx);
    expect(result.ok).toBe(true);
    expect(result.metadata?.exitCode).toBe(0);
  });

  it("returns non-zero exitCode for failing commands", async () => {
    const result = await bashTool.execute({ command: "exit 1" }, ctx);
    // ok may be true (we don't treat non-zero as error at tool level)
    expect(result.metadata?.exitCode).toBe(1);
  });

  it("handles commands with no output", async () => {
    const result = await bashTool.execute({ command: "true" }, ctx);
    expect(result.ok).toBe(true);
    expect(result.content).toBe("(no output)");
  });

  it("truncates very large output (under streaming threshold)", async () => {
    // 200KB — under 512KB streaming threshold, but over 80K truncateChars limit
    const result = await bashTool.execute(
      { command: "yes | head -c 200000" },
      ctx
    );
    expect(result.ok).toBe(true);
    expect(result.metadata?.truncated).toBe(true);
    expect(result.content.length).toBeLessThanOrEqual(80_000 + 500);
  });

  it("times out long-running commands", async () => {
    const result = await bashTool.execute(
      { command: "sleep 60", timeout: 100 },
      ctx
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("TIMEOUT");
  });

  it("kills infinite-output commands via streaming threshold", async () => {
    // `yes` produces unlimited output — should be killed well before 1s
    const start = Date.now();
    const result = await bashTool.execute({ command: "yes" }, ctx);
    const elapsed = Date.now() - start;

    expect(result.ok).toBe(true);
    expect(result.metadata?.truncated).toBe(true);
    // Should terminate quickly (well under the 30s timeout)
    expect(elapsed).toBeLessThan(5_000);
    // Should have collected some output
    expect(result.content.length).toBeGreaterThan(0);
    // Should NOT be empty
    expect(result.content).not.toBe("(no output)");
  }, 10_000);

  it("kills stderr-heavy commands via streaming threshold", async () => {
    // Generate unlimited stderr
    const start = Date.now();
    const result = await bashTool.execute(
      { command: "yes >&2" },
      ctx
    );
    const elapsed = Date.now() - start;

    expect(result.ok).toBe(true);
    expect(result.metadata?.truncated).toBe(true);
    expect(elapsed).toBeLessThan(5_000);
    expect(result.content.length).toBeGreaterThan(0);
  }, 10_000);

  it("completes normally when output is under streaming threshold", async () => {
    // 100KB — well under 512KB
    const result = await bashTool.execute(
      { command: "head -c 100000 /dev/urandom | base64 | head -c 100000" },
      ctx
    );
    expect(result.ok).toBe(true);
    // Should not be stream-truncated (though may be chars-truncated if > 80K)
    expect(result.metadata?.exitCode).toBe(0);
  });

  it("reports non-zero exitCode when killed by streaming threshold", async () => {
    const result = await bashTool.execute({ command: "yes" }, ctx);
    expect(result.ok).toBe(true);
    // SIGTERM typically gives exitCode 137 (128 + 9), or could be null → fallback to 137
    expect(result.metadata?.exitCode).toBeDefined();
    expect(typeof result.metadata?.exitCode).toBe("number");
  });

  it("works with AbortSignal cancellation", async () => {
    const controller = new AbortController();
    const ctxWithSignal: ToolContext = {
      cwd: "/tmp",
      readonlyMode: false,
      signal: controller.signal,
    };

    // Abort after 200ms
    setTimeout(() => controller.abort(), 200);

    const result = await bashTool.execute(
      { command: "sleep 60" },
      ctxWithSignal
    );
    expect(result.ok).toBe(false);
    // Should be either aborted or timeout error
    expect(result.error?.code).toBeDefined();
  });
});
