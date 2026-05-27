import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ToolRegistry } from "../src/tools/registry.js";
import type { ToolDef, ToolResult, ToolContext } from "../src/tools/types.js";
import { errorResult } from "../src/tools/types.js";
import { truncateOutput } from "../src/tools/utils/truncate.js";

function makeCtx(overrides?: Partial<ToolContext>): ToolContext {
  return { cwd: "/tmp", sessionId: "test-session", ...overrides };
}

function makeTool(
  name: string,
  execute?: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>,
  opts?: Partial<ToolDef["options"]>
): ToolDef {
  return {
    name,
    description: `${name} tool`,
    parameters: { type: "object" as const, properties: {} },
    execute: execute ?? (async () => ({ ok: true, content: `${name} done` })),
    options: opts,
  };
}

// ── T1: Idempotent Control ─────────────────────────────────────────────────

describe("T1 — Idempotent Control", () => {
  it("idempotent tool returns cached result on repeated call with same args", async () => {
    const registry = new ToolRegistry();
    let callCount = 0;
    const tool = makeTool("fetch", async () => {
      callCount++;
      return { ok: true, content: `result-${callCount}` };
    }, { idempotent: true });
    registry.register(tool);

    const ctx = makeCtx();
    const r1 = await registry.execute("fetch", { url: "http://example.com" }, ctx);
    const r2 = await registry.execute("fetch", { url: "http://example.com" }, ctx);

    expect(callCount).toBe(1);
    expect(r1.content).toBe("result-1");
    expect(r2.content).toBe("result-1");
    expect(r2).toEqual(r1);
  });

  it("non-idempotent tool executes every time", async () => {
    const registry = new ToolRegistry();
    let callCount = 0;
    const tool = makeTool("compute", async () => {
      callCount++;
      return { ok: true, content: `result-${callCount}` };
    });
    registry.register(tool);

    const ctx = makeCtx();
    const r1 = await registry.execute("compute", { x: 1 }, ctx);
    const r2 = await registry.execute("compute", { x: 1 }, ctx);

    expect(callCount).toBe(2);
    expect(r1.content).toBe("result-1");
    expect(r2.content).toBe("result-2");
  });

  it("idempotent tool with different args does not hit cache", async () => {
    const registry = new ToolRegistry();
    let callCount = 0;
    const tool = makeTool("fetch", async () => {
      callCount++;
      return { ok: true, content: `result-${callCount}` };
    }, { idempotent: true });
    registry.register(tool);

    const ctx = makeCtx();
    const r1 = await registry.execute("fetch", { url: "http://a.com" }, ctx);
    const r2 = await registry.execute("fetch", { url: "http://b.com" }, ctx);

    expect(callCount).toBe(2);
    expect(r1.content).toBe("result-1");
    expect(r2.content).toBe("result-2");
  });

  it("idempotent tool does not cache failed results", async () => {
    const registry = new ToolRegistry();
    let callCount = 0;
    const tool = makeTool("risky", async () => {
      callCount++;
      return errorResult("EXEC_ERROR", "boom");
    }, { idempotent: true });
    registry.register(tool);

    const ctx = makeCtx();
    const r1 = await registry.execute("risky", {}, ctx);
    const r2 = await registry.execute("risky", {}, ctx);

    expect(callCount).toBe(2);
    expect(r1.ok).toBe(false);
    expect(r2.ok).toBe(false);
  });

  it("clearIdempotentCache resets the cache", async () => {
    const registry = new ToolRegistry();
    let callCount = 0;
    const tool = makeTool("fetch", async () => {
      callCount++;
      return { ok: true, content: `result-${callCount}` };
    }, { idempotent: true });
    registry.register(tool);

    const ctx = makeCtx();
    await registry.execute("fetch", { url: "x" }, ctx);
    registry.clearIdempotentCache();
    await registry.execute("fetch", { url: "x" }, ctx);

    expect(callCount).toBe(2);
  });
});

// ── T2: Retryable Error Classification ──────────────────────────────────────

describe("T2 — Retryable Error Classification", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("retries retryable errors automatically up to 3 times", async () => {
    const registry = new ToolRegistry();
    let attempts = 0;
    const tool = makeTool("flaky", async () => {
      attempts++;
      if (attempts < 3) {
        return errorResult("EXEC_ERROR", "transient failure", true);
      }
      return { ok: true, content: "success" };
    });
    registry.register(tool);

    const ctx = makeCtx();
    const promise = registry.execute("flaky", {}, ctx);

    // Advance through retries: 100ms, 200ms
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(200);

    const result = await promise;
    expect(attempts).toBe(3);
    expect(result.ok).toBe(true);
    expect(result.content).toBe("success");
    expect(result.retryCount).toBe(2);
  });

  it("non-retryable errors are not retried", async () => {
    const registry = new ToolRegistry();
    let attempts = 0;
    const tool = makeTool("perm-fail", async () => {
      attempts++;
      return errorResult("PERMISSION_DENIED", "no access", false);
    });
    registry.register(tool);

    const ctx = makeCtx();
    const result = await registry.execute("perm-fail", {}, ctx);

    expect(attempts).toBe(1);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("PERMISSION_DENIED");
    expect(result.retryCount).toBe(0);
  });

  it("gives up after max retries (3)", async () => {
    const registry = new ToolRegistry();
    let attempts = 0;
    const tool = makeTool("always-fail", async () => {
      attempts++;
      return errorResult("EXEC_ERROR", "persistent failure", true);
    });
    registry.register(tool);

    const ctx = makeCtx();
    const promise = registry.execute("always-fail", {}, ctx);

    // Advance through all retries: 100ms, 200ms, 400ms
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(200);
    await vi.advanceTimersByTimeAsync(400);

    const result = await promise;
    expect(attempts).toBe(4); // 1 initial + 3 retries
    expect(result.ok).toBe(false);
    expect(result.retryCount).toBe(3);
  });

  it("uses exponential backoff: 100ms, 200ms, 400ms", async () => {
    const registry = new ToolRegistry();
    const timestamps: number[] = [];
    const tool = makeTool("slow-fail", async () => {
      timestamps.push(Date.now());
      return errorResult("EXEC_ERROR", "fail", true);
    });
    registry.register(tool);

    const ctx = makeCtx();
    const start = Date.now();
    const promise = registry.execute("slow-fail", {}, ctx);

    // Advance time step by step and verify backoff pattern
    await vi.advanceTimersByTimeAsync(50); // not enough for first retry
    expect(timestamps.length).toBe(1); // only initial call

    await vi.advanceTimersByTimeAsync(50); // 100ms total — first retry fires
    // Allow microtask to settle
    await vi.advanceTimersByTimeAsync(0);
    expect(timestamps.length).toBe(2);

    await vi.advanceTimersByTimeAsync(200); // 200ms — second retry
    await vi.advanceTimersByTimeAsync(0);
    expect(timestamps.length).toBe(3);

    await vi.advanceTimersByTimeAsync(400); // 400ms — third retry
    await vi.advanceTimersByTimeAsync(0);
    expect(timestamps.length).toBe(4);

    await promise;
  });

  it("retryable exception (thrown) is also retried", async () => {
    const registry = new ToolRegistry();
    let attempts = 0;
    const tool = makeTool("thrower", async () => {
      attempts++;
      if (attempts < 2) {
        throw new Error("transient crash");
      }
      return { ok: true, content: "recovered" };
    });
    registry.register(tool);

    const ctx = makeCtx();
    const promise = registry.execute("thrower", {}, ctx);

    await vi.advanceTimersByTimeAsync(100);
    const result = await promise;

    expect(attempts).toBe(2);
    expect(result.ok).toBe(true);
    expect(result.content).toBe("recovered");
  });
});

// ── T3: Dry-Run / Simulate ──────────────────────────────────────────────────

describe("T3 — Dry-Run / Simulate", () => {
  it("returns simulated result when dryRun is true", async () => {
    const registry = new ToolRegistry();
    const tool = makeTool("deploy", async () => ({ ok: true, content: "deployed" }));
    registry.register(tool);

    const ctx = makeCtx({ dryRun: true });
    const result = await registry.execute("deploy", { env: "prod" }, ctx);

    expect(result.ok).toBe(true);
    expect(result.content).toBe('[DRY RUN] Would execute: deploy({"env":"prod"})');
    expect(result.dryRun).toBe(true);
  });

  it("does not actually execute the tool in dry-run mode", async () => {
    const registry = new ToolRegistry();
    const spy = vi.fn(async () => ({ ok: true, content: "executed" }));
    const tool = makeTool("write", spy);
    registry.register(tool);

    const ctx = makeCtx({ dryRun: true });
    await registry.execute("write", { file: "test.txt" }, ctx);

    expect(spy).not.toHaveBeenCalled();
  });

  it("dry-run preserves tool name and args in output", async () => {
    const registry = new ToolRegistry();
    registry.register(makeTool("bash", async () => ({ ok: true, content: "" })));

    const ctx = makeCtx({ dryRun: true });
    const result = await registry.execute(
      "bash",
      { command: "rm -rf /tmp/test" },
      ctx
    );

    expect(result.content).toContain("bash");
    expect(result.content).toContain("rm -rf /tmp/test");
  });

  it("dry-run returns error for unknown tool", async () => {
    const registry = new ToolRegistry();
    const ctx = makeCtx({ dryRun: true });
    const result = await registry.execute("nonexistent", {}, ctx);

    // Unknown tool check happens before dry-run
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("UNKNOWN");
  });
});

// ── T4: Output Truncation ───────────────────────────────────────────────────

describe("T4 — Output Truncation", () => {
  it("truncates long output preserving head and tail", () => {
    // maxTokens=10 → maxChars=40. head=24 chars, tail=16 chars
    const output = "A".repeat(30) + "MIDDLE" + "B".repeat(30); // 66 chars
    const result = truncateOutput(output, 10);

    expect(result.wasTruncated).toBe(true);
    expect(result.originalLength).toBe(66);
    expect(result.truncated).toContain("A".repeat(24));
    expect(result.truncated).toContain("B".repeat(16));
    expect(result.truncated).toContain("[...truncated");
  });

  it("does not truncate short output", () => {
    const output = "short output";
    const result = truncateOutput(output, 4000);

    expect(result.wasTruncated).toBe(false);
    expect(result.truncated).toBe(output);
    expect(result.originalLength).toBe(output.length);
  });

  it("truncation ratio is approximately 60/40", () => {
    const maxTokens = 10;
    const maxChars = maxTokens * 4; // 40
    const output = "X".repeat(200);
    const result = truncateOutput(output, maxTokens);

    expect(result.wasTruncated).toBe(true);

    // Extract the head and tail from the truncated output
    const markerIdx = result.truncated.indexOf("[...truncated");
    const head = result.truncated.slice(0, markerIdx);
    const tailStart = result.truncated.indexOf("]", markerIdx) + 1;
    const tail = result.truncated.slice(tailStart);

    const expectedHead = Math.floor(maxChars * 0.6); // 24
    const expectedTail = maxChars - expectedHead; // 16

    expect(head.length).toBe(expectedHead);
    expect(tail.length).toBe(expectedTail);
  });

  it("originalLength records the full output length", () => {
    const output = "a".repeat(10000);
    const result = truncateOutput(output, 100);

    expect(result.originalLength).toBe(10000);
  });

  it("marker includes correct truncated char count", () => {
    const maxTokens = 5; // 20 chars budget
    const output = "Z".repeat(100);
    const result = truncateOutput(output, maxTokens);

    const headLen = Math.floor(20 * 0.6); // 12
    const tailLen = 20 - headLen; // 8
    const removedChars = 100 - headLen - tailLen; // 80

    expect(result.truncated).toContain(`[...truncated ${removedChars} chars...]`);
  });

  it("uses default maxTokens of 4000 when not specified", () => {
    const maxChars = 4000 * 4; // 16000
    const output = "x".repeat(maxChars); // exactly at limit
    const result = truncateOutput(output);

    expect(result.wasTruncated).toBe(false);
  });

  it("truncates when output exceeds default limit by one char", () => {
    const maxChars = 4000 * 4; // 16000
    const output = "x".repeat(maxChars + 1);
    const result = truncateOutput(output);

    expect(result.wasTruncated).toBe(true);
  });
});
