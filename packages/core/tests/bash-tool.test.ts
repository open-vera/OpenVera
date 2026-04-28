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

  it("truncates very large output", async () => {
    // generate ~100KB of output
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
});
