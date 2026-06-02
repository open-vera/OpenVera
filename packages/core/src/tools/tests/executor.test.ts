import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { executeWithTimeout } from "../executor.js";
import { retryWithPolicy } from "../executor.js";
import type { ToolResult } from "../types.js";
import { errorResult } from "../types.js";

// ── Helpers ────────────────────────────────────────────────────────────────────

function okResult(content = "success"): ToolResult {
  return { ok: true, content };
}

function errResult(
  code: ToolResult["error"]["code"] = "EXEC_ERROR",
  retryable = false,
  message = "fail"
): ToolResult {
  return {
    ok: false,
    content: message,
    error: { code, message, retryable },
  };
}

function retryableErr(message = "transient error"): ToolResult {
  return {
    ok: false,
    content: message,
    error: { code: "TIMEOUT", message, retryable: true },
  };
}

function delayed<T>(ms: number, value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(resolve, ms, value));
}

/** A promise that never settles. */
function never<T>(): Promise<T> {
  return new Promise(() => {});
}

/**
 * Flush microtasks without advancing timers. With fake timers,
 * advanceTimersByTimeAsync(0) runs pending microtasks.
 */
async function flushMicrotasks(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

// ── executeWithTimeout ─────────────────────────────────────────────────────────

describe("executeWithTimeout", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("happy path", () => {
    it("resolves with the fn result when it completes before timeout", async () => {
      const promise = executeWithTimeout(async () => 42, 1000);
      await vi.runAllTimersAsync();
      expect(await promise).toBe(42);
    });

    it("resolves with an object result", async () => {
      const obj = { name: "test", value: 123 };
      const promise = executeWithTimeout(async () => obj, 1000);
      await vi.runAllTimersAsync();
      expect(await promise).toEqual(obj);
    });

    it("resolves with undefined when fn returns undefined", async () => {
      const promise = executeWithTimeout(
        async () => undefined as unknown as string,
        1000
      );
      await vi.runAllTimersAsync();
      expect(await promise).toBeUndefined();
    });

    it("resolves with null when fn returns null", async () => {
      const promise = executeWithTimeout(
        async () => null as unknown as string,
        1000
      );
      await vi.runAllTimersAsync();
      expect(await promise).toBeNull();
    });

    it("resolves with async fn that uses timers internally", async () => {
      const promise = executeWithTimeout(() => delayed(50, "arrived"), 500);
      await vi.advanceTimersByTimeAsync(50);
      await flushMicrotasks();
      expect(await promise).toBe("arrived");
    });
  });

  describe("timeout", () => {
    it("rejects with TIMEOUT error when fn exceeds timeout", async () => {
      const promise = executeWithTimeout(() => never<string>(), 1000);

      // Attach rejection handler BEFORE advancing timers so vitest
      // knows the rejection will be handled.
      const rejection = expect(promise).rejects.toMatchObject({ name: "TimeoutError" });
      await vi.advanceTimersByTimeAsync(1001);
      await rejection;
    });

    it("rejects with correct content message and code", async () => {
      const promise = executeWithTimeout(() => never<string>(), 250);

      const rejection = expect(promise).rejects.toMatchObject({
        name: "TimeoutError",
        ok: false,
        content: expect.stringContaining("250ms"),
        error: { code: "TIMEOUT", retryable: false },
      });
      await vi.advanceTimersByTimeAsync(251);
      await rejection;
    });

    it("includes timeoutMs in the error message", async () => {
      const promise = executeWithTimeout(() => never<string>(), 777);

      const rejection = expect(promise).rejects.toMatchObject({
        content: expect.stringContaining("777ms"),
      });
      await vi.advanceTimersByTimeAsync(778);
      await rejection;
    });

    it("times out immediately when timeoutMs is 0", async () => {
      const promise = executeWithTimeout(() => never<string>(), 0);

      const rejection = expect(promise).rejects.toMatchObject({ name: "TimeoutError" });
      await vi.advanceTimersByTimeAsync(0);
      await rejection;
    });
  });

  describe("error propagation (fn rejects before timeout)", () => {
    it("propagates errors when fn rejects synchronously", async () => {
      const error = new Error("fn failure");
      const fn = vi.fn().mockRejectedValue(error);
      const promise = executeWithTimeout(fn, 1000);

      const rejection = expect(promise).rejects.toBe(error);
      await flushMicrotasks();
      await rejection;
    });

    it("propagates custom error types with extra properties", async () => {
      class CustomError extends Error {
        constructor(
          message: string,
          public code: number
        ) {
          super(message);
          this.name = "CustomError";
        }
      }

      const error = new CustomError("custom failure", 418);
      // Defer the rejection via setTimeout to avoid the synchronous
      // unhandled-rejection window that vitest flags with fake timers.
      const promise = executeWithTimeout(
        () =>
          new Promise<string>((_, reject) => {
            setTimeout(() => reject(error), 0);
          }),
        1000
      );

      const rejection = expect(promise).rejects.toBe(error);
      await vi.advanceTimersByTimeAsync(0); // fire setTimeout(0)
      await rejection;
      await expect(promise).rejects.toMatchObject({
        name: "CustomError",
        code: 418,
      });
    });

    it("clears the timer when fn rejects via delayed reject", async () => {
      const promise = executeWithTimeout(
        () =>
          new Promise<string>((_, reject) => {
            setTimeout(() => reject(new Error("fast fail")), 50);
          }),
        5000
      );

      const rejection = expect(promise).rejects.toThrow("fast fail");
      await vi.advanceTimersByTimeAsync(100);
      await rejection;

      // Advance way past timeout — timer should have been cleared
      await vi.advanceTimersByTimeAsync(10000);
    });
  });

  describe("edge case: very large timeout", () => {
    it("does not reject when fn completes within a long timeout", async () => {
      const promise = executeWithTimeout(() => delayed(500, "done"), 60000);

      await vi.advanceTimersByTimeAsync(500);
      await flushMicrotasks();
      expect(await promise).toBe("done");
    });
  });
});

// ── retryWithPolicy ────────────────────────────────────────────────────────────

describe("retryWithPolicy", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("happy path", () => {
    it("returns the result immediately if first attempt succeeds", async () => {
      const fn = vi.fn().mockResolvedValue(okResult("done"));
      const result = await retryWithPolicy(fn, 3);

      expect(result.ok).toBe(true);
      expect(result.content).toBe("done");
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("returns the result when fn succeeds on second attempt", async () => {
      const fn = vi
        .fn()
        .mockResolvedValueOnce(retryableErr("fail1"))
        .mockResolvedValueOnce(okResult("finally"));

      const promise = retryWithPolicy(fn, 3);

      // sleep(200) needs to fire for attempt 1 to run
      await vi.advanceTimersByTimeAsync(200);
      await flushMicrotasks();

      const result = await promise;
      expect(result.ok).toBe(true);
      expect(result.content).toBe("finally");
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it("retries up to specified count before succeeding", async () => {
      const fn = vi
        .fn()
        .mockResolvedValueOnce(retryableErr("fail1"))
        .mockResolvedValueOnce(retryableErr("fail2"))
        .mockResolvedValueOnce(okResult("win"));

      const promise = retryWithPolicy(fn, 3);

      // sleep(200) → attempt 1 fires
      await vi.advanceTimersByTimeAsync(200);
      await flushMicrotasks();
      // sleep(400) → attempt 2 fires (succeeds)
      await vi.advanceTimersByTimeAsync(400);
      await flushMicrotasks();

      const result = await promise;
      expect(result.ok).toBe(true);
      expect(result.content).toBe("win");
      expect(fn).toHaveBeenCalledTimes(3);
    });

    it("returns last result after exhausting all retries", async () => {
      const fn = vi.fn().mockResolvedValue(retryableErr("always fails"));

      const promise = retryWithPolicy(fn, 2);

      // sleep(200) → attempt 1
      await vi.advanceTimersByTimeAsync(200);
      await flushMicrotasks();
      // sleep(400) → attempt 2 (exhausted)
      await vi.advanceTimersByTimeAsync(400);
      await flushMicrotasks();

      const result = await promise;
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("TIMEOUT");
      expect(result.error?.retryable).toBe(true);
      expect(fn).toHaveBeenCalledTimes(3);
    });
  });

  describe("non-retryable errors", () => {
    it("stops immediately on non-retryable error", async () => {
      const fn = vi
        .fn()
        .mockResolvedValue(errResult("PERMISSION_DENIED", false));

      const result = await retryWithPolicy(fn, 3);

      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("PERMISSION_DENIED");
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("stops after a retryable error then a non-retryable error", async () => {
      const fn = vi
        .fn()
        .mockResolvedValueOnce(retryableErr("transient"))
        .mockResolvedValueOnce(errResult("PERMISSION_DENIED", false));

      const promise = retryWithPolicy(fn, 3);

      // sleep(200) → attempt 1 (non-retryable, returns immediately)
      await vi.advanceTimersByTimeAsync(200);
      await flushMicrotasks();

      const result = await promise;
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("PERMISSION_DENIED");
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it("stops when error has no retryable field (undefined)", async () => {
      const fn = vi.fn().mockResolvedValue({
        ok: false as const,
        content: "weird error",
        error: {
          code: "UNKNOWN" as const,
          message: "odd",
        } as ToolResult["error"],
      });

      const result = await retryWithPolicy(fn, 3);

      expect(result.ok).toBe(false);
      expect(fn).toHaveBeenCalledTimes(1);
    });
  });

  describe("exponential backoff", () => {
    it("uses exponential backoff: 200ms, 400ms, 800ms", async () => {
      const fn = vi.fn().mockResolvedValue(retryableErr("fail"));

      const promise = retryWithPolicy(fn, 3);

      // Attempt 0 completes immediately (sync mock), schedules sleep(200)
      // Advance 200ms → sleep(200) fires → attempt 1 runs → schedules sleep(400)
      await vi.advanceTimersByTimeAsync(200);
      await flushMicrotasks();
      expect(fn).toHaveBeenCalledTimes(2); // attempt 0 + attempt 1

      // Advance 400ms → sleep(400) fires → attempt 2 runs → schedules sleep(800)
      await vi.advanceTimersByTimeAsync(400);
      await flushMicrotasks();
      expect(fn).toHaveBeenCalledTimes(3); // + attempt 2

      // Advance 800ms → sleep(800) fires → attempt 3 runs → loop ends (attempt 3 = retries)
      await vi.advanceTimersByTimeAsync(800);
      await flushMicrotasks();
      expect(fn).toHaveBeenCalledTimes(4); // + attempt 3

      const result = await promise;
      expect(result.ok).toBe(false);
    });

    it("does not fire the next attempt before backoff has elapsed", async () => {
      const fn = vi.fn().mockResolvedValue(retryableErr("fail"));

      // Start the retry loop (don't await — it suspends on sleep(200))
      retryWithPolicy(fn, 2);

      // Advance only 100ms (less than 200ms backoff) — sleep(200) should NOT fire
      await vi.advanceTimersByTimeAsync(100);
      await flushMicrotasks();
      expect(fn).toHaveBeenCalledTimes(1); // only attempt 0

      // Advance another 100ms to reach 200ms total — sleep(200) fires
      await vi.advanceTimersByTimeAsync(100);
      await flushMicrotasks();
      expect(fn).toHaveBeenCalledTimes(2); // attempt 1 fires
    });
  });

  describe("edge cases", () => {
    it("retries=0 makes exactly one attempt", async () => {
      const fn = vi.fn().mockResolvedValue(okResult("done"));
      const result = await retryWithPolicy(fn, 0);

      expect(result.ok).toBe(true);
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("retries=0 with failure returns the failure", async () => {
      const fn = vi.fn().mockResolvedValue(retryableErr("oops"));
      const result = await retryWithPolicy(fn, 0);

      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("TIMEOUT");
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("handles async fn with real successes after retries", async () => {
      let callCount = 0;
      const fn = async (): Promise<ToolResult> => {
        callCount++;
        if (callCount <= 2) return retryableErr(`attempt ${callCount}`);
        return okResult("win");
      };

      const promise = retryWithPolicy(fn, 3);

      // sleep(200) → attempt 2
      await vi.advanceTimersByTimeAsync(200);
      await flushMicrotasks();
      expect(callCount).toBe(2);

      // sleep(400) → attempt 3 (success)
      await vi.advanceTimersByTimeAsync(400);
      await flushMicrotasks();
      expect(callCount).toBe(3);

      const result = await promise;
      expect(result.ok).toBe(true);
      expect(result.content).toBe("win");
    });

    it("handles different retryable error codes", async () => {
      const fn = vi
        .fn()
        .mockResolvedValueOnce({
          ok: false as const,
          content: "timeout",
          error: { code: "TIMEOUT" as const, message: "timed out", retryable: true },
        })
        .mockResolvedValueOnce({
          ok: false as const,
          content: "budget",
          error: { code: "BUDGET_EXCEEDED" as const, message: "no budget", retryable: true },
        })
        .mockResolvedValueOnce(okResult("eventual success"));

      const promise = retryWithPolicy(fn, 3);

      await vi.advanceTimersByTimeAsync(200);
      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(400);
      await flushMicrotasks();

      const result = await promise;
      expect(result.ok).toBe(true);
      expect(fn).toHaveBeenCalledTimes(3);
    });

    it("does not retry when first result is ok", async () => {
      const fn = vi.fn().mockResolvedValue(okResult("instant win"));
      const result = await retryWithPolicy(fn, 5);

      expect(result.ok).toBe(true);
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("handles large retry count with all failures", async () => {
      const fn = vi.fn().mockResolvedValue(retryableErr("persistent"));

      const promise = retryWithPolicy(fn, 5);

      // Advance past all backoff sleeps:
      // sleep(200) → sleep(400) → sleep(800) → sleep(1600) → sleep(3200)
      await vi.advanceTimersByTimeAsync(200);
      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(400);
      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(800);
      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(1600);
      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(3200);
      await flushMicrotasks();

      const result = await promise;
      expect(result.ok).toBe(false);
      expect(fn).toHaveBeenCalledTimes(6); // initial + 5 retries
    });
  });

  describe("result structure preservation", () => {
    it("preserves metadata on successful result", async () => {
      const result: ToolResult = {
        ok: true,
        content: "read file",
        metadata: {
          bytesRead: 1024,
          linesRead: 42,
          renderHint: { type: "text" },
        },
      };

      const fn = vi.fn().mockResolvedValue(result);
      const retry = await retryWithPolicy(fn, 0);

      expect(retry.content).toBe("read file");
      expect(retry.metadata?.bytesRead).toBe(1024);
      expect(retry.metadata?.linesRead).toBe(42);
      expect(retry.metadata?.renderHint).toEqual({ type: "text" });
    });

    it("preserves needsConfirm on a result", async () => {
      const needsConfirmResult: ToolResult = {
        ok: false,
        content: "needs confirmation",
        error: { code: "PERMISSION_DENIED", message: "need approval", retryable: false },
        needsConfirm: {
          message: "Allow access to /tmp?",
          allowDir: "/tmp",
          retry: { name: "bash", args: { cmd: "ls" } },
        },
      };

      const fn = vi.fn().mockResolvedValue(needsConfirmResult);
      const retry = await retryWithPolicy(fn, 0);

      expect(retry.needsConfirm).toBeDefined();
      expect(retry.needsConfirm?.message).toBe("Allow access to /tmp?");
      expect(retry.needsConfirm?.allowDir).toBe("/tmp");
    });

    it("preserves dryRun flag on result", async () => {
      const dryRunResult: ToolResult = {
        ok: true,
        content: "would do X",
        dryRun: true,
      };

      const fn = vi.fn().mockResolvedValue(dryRunResult);
      const retry = await retryWithPolicy(fn, 0);

      expect(retry.dryRun).toBe(true);
    });

    it("preserves diff metadata on result", async () => {
      const diffResult: ToolResult = {
        ok: true,
        content: "patched",
        metadata: {
          diff: {
            filePath: "/tmp/test.ts",
            hunks: [
              {
                oldStart: 1,
                oldLines: 2,
                newStart: 1,
                newLines: 3,
                lines: [" line1", "+line2", "+line3"],
              },
            ],
          },
        },
      };

      const fn = vi.fn().mockResolvedValue(diffResult);
      const retry = await retryWithPolicy(fn, 0);

      expect(retry.ok).toBe(true);
      expect(retry.metadata?.diff?.filePath).toBe("/tmp/test.ts");
      expect(retry.metadata?.diff?.hunks).toHaveLength(1);
    });

    it("preserves retryCount field on result", async () => {
      const result: ToolResult = {
        ok: true,
        content: "ok after retry",
        retryCount: 2,
      };

      const fn = vi.fn().mockResolvedValue(result);
      const retry = await retryWithPolicy(fn, 0);

      expect(retry.retryCount).toBe(2);
    });
  });

  describe("errorResult helper", () => {
    it("constructs an error ToolResult with correct shape", () => {
      const result = errorResult("TIMEOUT", "too slow", true);

      expect(result).toMatchObject({
        ok: false,
        content: "too slow",
        error: { code: "TIMEOUT", message: "too slow", retryable: true },
      });
    });

    it("defaults retryable to false", () => {
      const result = errorResult("EXEC_ERROR", "boom");
      expect(result.error?.retryable).toBe(false);
    });

    it("works for all defined error codes", () => {
      const codes = [
        "PERMISSION_DENIED",
        "PATH_OUTSIDE_CWD",
        "BUDGET_EXCEEDED",
        "TIMEOUT",
        "NOT_FOUND",
        "EXEC_ERROR",
        "UNKNOWN",
      ] as const;

      for (const code of codes) {
        const result = errorResult(code, `error: ${code}`);
        expect(result.error?.code).toBe(code);
        expect(result.ok).toBe(false);
      }
    });
  });
});
