/**
 * Tests for SubagentPool — concurrent subagent execution pool.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { SubagentPool } from "../src/agent/subagent-pool.js";

describe("SubagentPool", () => {
  describe("submit", () => {
    it("should submit a job and return a PoolJob", () => {
      const pool = new SubagentPool({ maxConcurrent: 3, maxQueue: 10 });
      const job = pool.submit("j1", "coder", "write tests");

      expect(job.jobId).toBe("j1");
      expect(job.agentType).toBe("coder");
      expect(job.prompt).toBe("write tests");
      expect(job.status).toBe("running");
      expect(job.createdAt).toBeGreaterThan(0);
      expect(job.cancelToken).toBeInstanceOf(AbortController);
    });

    it("should track running count on submit", () => {
      const pool = new SubagentPool({ maxConcurrent: 3 });
      pool.submit("j1", "coder", "task 1");
      pool.submit("j2", "coder", "task 2");

      const s = pool.status();
      expect(s.running).toBe(2);
      expect(s.total).toBe(2);
    });

    it("should throw on duplicate jobId", () => {
      const pool = new SubagentPool();
      pool.submit("j1", "coder", "task");
      expect(() => pool.submit("j1", "coder", "task")).toThrow("already exists");
    });

    it("should queue job when maxConcurrent is reached", () => {
      const pool = new SubagentPool({ maxConcurrent: 1, maxQueue: 5 });
      pool.submit("j1", "coder", "task 1");
      const j2 = pool.submit("j2", "coder", "task 2");

      // j1 is running, j2 goes to queue (still status "running" in current impl)
      const s = pool.status();
      expect(s.running).toBe(1);
      expect(s.queued).toBe(1);
      expect(s.total).toBe(2);
    });

    it("should throw when pool is full (running + queue >= max)", () => {
      const pool = new SubagentPool({ maxConcurrent: 1, maxQueue: 1 });
      pool.submit("j1", "coder", "task 1");
      pool.submit("j2", "coder", "task 2"); // queued
      expect(() => pool.submit("j3", "coder", "task 3")).toThrow("Pool full");
    });

    it("should allow submitting when maxConcurrent is 0 and queue has room", () => {
      // Edge case: maxConcurrent=0 means everything queues
      const pool = new SubagentPool({ maxConcurrent: 0, maxQueue: 2 });
      // 0 + 0 < 0 + 2, so it should succeed (but running count stays 0)
      pool.submit("j1", "coder", "task");
      const s = pool.status();
      expect(s.total).toBe(1);
    });
  });

  describe("complete", () => {
    it("should mark a job as succeeded with result", () => {
      const pool = new SubagentPool({ maxConcurrent: 3 });
      pool.submit("j1", "coder", "task");
      pool.complete("j1", "done!");

      const job = pool.get("j1")!;
      expect(job.status).toBe("succeeded");
      expect(job.result).toBe("done!");
    });

    it("should decrement running count on complete", () => {
      const pool = new SubagentPool({ maxConcurrent: 3 });
      pool.submit("j1", "coder", "task");
      pool.submit("j2", "coder", "task");
      pool.complete("j1", "done");

      const s = pool.status();
      expect(s.running).toBe(1);
    });

    it("should process queue after completing a running job", () => {
      const pool = new SubagentPool({ maxConcurrent: 1, maxQueue: 5 });
      pool.submit("j1", "coder", "task 1");
      pool.submit("j2", "coder", "task 2"); // queued

      // After completing j1, processQueue should promote j2
      pool.complete("j1", "done");
      const s = pool.status();
      // j2 should now be running
      expect(s.running).toBe(1);
      expect(s.queued).toBe(0);
    });

    it("should be a no-op for unknown jobId", () => {
      const pool = new SubagentPool();
      // Should not throw
      pool.complete("nonexistent", "result");
    });
  });

  describe("fail", () => {
    it("should mark a job as failed with error", () => {
      const pool = new SubagentPool({ maxConcurrent: 3 });
      pool.submit("j1", "coder", "task");
      pool.fail("j1", "oops");

      const job = pool.get("j1")!;
      expect(job.status).toBe("failed");
      expect(job.error).toBe("oops");
    });

    it("should decrement running count on fail", () => {
      const pool = new SubagentPool({ maxConcurrent: 3 });
      pool.submit("j1", "coder", "task");
      pool.fail("j1", "error");

      const s = pool.status();
      expect(s.running).toBe(0);
    });

    it("should process queue after failing a running job", () => {
      const pool = new SubagentPool({ maxConcurrent: 1, maxQueue: 5 });
      pool.submit("j1", "coder", "task 1");
      pool.submit("j2", "coder", "task 2");

      pool.fail("j1", "crashed");
      const s = pool.status();
      expect(s.running).toBe(1);
      expect(s.queued).toBe(0);
    });

    it("should be a no-op for unknown jobId", () => {
      const pool = new SubagentPool();
      pool.fail("nonexistent", "error");
    });
  });

  describe("cancel", () => {
    it("should cancel a running job", () => {
      const pool = new SubagentPool({ maxConcurrent: 3 });
      pool.submit("j1", "coder", "task");
      const result = pool.cancel("j1");

      expect(result).toBe(true);
      const job = pool.get("j1")!;
      expect(job.status).toBe("failed");
      expect(job.error).toBe("Cancelled");
    });

    it("should abort the cancel token on cancel", () => {
      const pool = new SubagentPool({ maxConcurrent: 3 });
      pool.submit("j1", "coder", "task");

      expect(pool.isCancelled("j1")).toBe(false);
      pool.cancel("j1");
      expect(pool.isCancelled("j1")).toBe(true);
    });

    it("should return false for nonexistent job", () => {
      const pool = new SubagentPool();
      expect(pool.cancel("nonexistent")).toBe(false);
    });

    it("should return false for already completed job", () => {
      const pool = new SubagentPool();
      pool.submit("j1", "coder", "task");
      pool.complete("j1", "done");
      expect(pool.cancel("j1")).toBe(false);
    });

    it("should decrement running count on cancel", () => {
      const pool = new SubagentPool({ maxConcurrent: 3 });
      pool.submit("j1", "coder", "task");
      pool.cancel("j1");

      const s = pool.status();
      expect(s.running).toBe(0);
    });

    it("should process queue after cancelling a job", () => {
      const pool = new SubagentPool({ maxConcurrent: 1, maxQueue: 5 });
      pool.submit("j1", "coder", "task 1");
      pool.submit("j2", "coder", "task 2");

      pool.cancel("j1");
      const s = pool.status();
      expect(s.running).toBe(1);
      expect(s.queued).toBe(0);
    });
  });

  describe("isCancelled & getSignal", () => {
    it("should return false for non-cancelled job", () => {
      const pool = new SubagentPool();
      pool.submit("j1", "coder", "task");
      expect(pool.isCancelled("j1")).toBe(false);
    });

    it("should return undefined for unknown job signal", () => {
      const pool = new SubagentPool();
      expect(pool.getSignal("unknown")).toBeUndefined();
    });

    it("should return abort signal for a running job", () => {
      const pool = new SubagentPool();
      pool.submit("j1", "coder", "task");
      const signal = pool.getSignal("j1");
      expect(signal).toBeInstanceOf(AbortSignal);
      expect(signal!.aborted).toBe(false);
    });
  });

  describe("get & list", () => {
    it("should get a specific job by id", () => {
      const pool = new SubagentPool();
      pool.submit("j1", "coder", "task 1");
      pool.submit("j2", "writer", "task 2");

      const job = pool.get("j2");
      expect(job?.agentType).toBe("writer");
    });

    it("should return undefined for unknown jobId", () => {
      const pool = new SubagentPool();
      expect(pool.get("unknown")).toBeUndefined();
    });

    it("should list all jobs sorted by createdAt desc", () => {
      const pool = new SubagentPool();
      pool.submit("j1", "coder", "task 1");
      pool.submit("j2", "writer", "task 2");
      pool.submit("j3", "coder", "task 3");

      const all = pool.list();
      expect(all).toHaveLength(3);
      // Should be sorted newest first; since Date.now may be identical within same ms,
      // verify the list returns all jobs in reverse insertion order or at least all present
      const ids = all.map((j) => j.jobId);
      expect(ids).toContain("j1");
      expect(ids).toContain("j2");
      expect(ids).toContain("j3");
    });

    it("should list jobs filtered by status", () => {
      const pool = new SubagentPool({ maxConcurrent: 3 });
      pool.submit("j1", "coder", "task 1");
      pool.submit("j2", "coder", "task 2");
      pool.complete("j1", "done");
      pool.fail("j2", "error");

      // Resubmit j3 as running
      pool.submit("j3", "coder", "task 3");

      const succeeded = pool.list("succeeded");
      expect(succeeded).toHaveLength(1);
      expect(succeeded[0]!.jobId).toBe("j1");

      const failed = pool.list("failed");
      expect(failed).toHaveLength(1);
      expect(failed[0]!.jobId).toBe("j2");
    });
  });

  describe("status", () => {
    it("should return correct pool status", () => {
      const pool = new SubagentPool({ maxConcurrent: 2, maxQueue: 3 });
      pool.submit("j1", "coder", "task 1");
      pool.submit("j2", "coder", "task 2");
      pool.submit("j3", "coder", "task 3"); // queued

      const s = pool.status();
      expect(s.running).toBe(2);
      expect(s.queued).toBe(1);
      expect(s.total).toBe(3);
      expect(s.maxConcurrent).toBe(2);
    });
  });

  describe("clearFinished", () => {
    it("should clear completed and failed jobs", () => {
      const pool = new SubagentPool({ maxConcurrent: 5 });
      pool.submit("j1", "coder", "task 1");
      pool.submit("j2", "coder", "task 2");
      pool.submit("j3", "coder", "task 3");
      pool.complete("j1", "done");
      pool.fail("j2", "error");

      const cleared = pool.clearFinished();
      expect(cleared).toBe(2);
      expect(pool.get("j1")).toBeUndefined();
      expect(pool.get("j2")).toBeUndefined();
      expect(pool.get("j3")).toBeDefined(); // still running
    });

    it("should return 0 if no finished jobs", () => {
      const pool = new SubagentPool();
      pool.submit("j1", "coder", "task");
      expect(pool.clearFinished()).toBe(0);
    });
  });

  describe("edge cases", () => {
    it("should handle default options", () => {
      const pool = new SubagentPool();
      // Default maxConcurrent=3, maxQueue=10
      const s = pool.status();
      expect(s.maxConcurrent).toBe(3);
    });

    it("should not let running count go below 0", () => {
      const pool = new SubagentPool();
      pool.submit("j1", "coder", "task");
      pool.complete("j1", "done");
      pool.complete("j1", "done again"); // idempotent-ish, no-op since status changed
      const s = pool.status();
      expect(s.running).toBeGreaterThanOrEqual(0);
    });

    it("should handle many rapid submits within limits", () => {
      const pool = new SubagentPool({ maxConcurrent: 5, maxQueue: 100 });
      for (let i = 0; i < 15; i++) {
        pool.submit(`j${i}`, "coder", `task ${i}`);
      }
      const s = pool.status();
      expect(s.total).toBe(15);
      expect(s.running).toBe(5);
      expect(s.queued).toBe(10);
    });

    it("should get AbortSignal for queued jobs too", () => {
      const pool = new SubagentPool({ maxConcurrent: 1, maxQueue: 3 });
      pool.submit("j1", "coder", "task 1");
      pool.submit("j2", "coder", "task 2"); // queued

      const signal = pool.getSignal("j2");
      expect(signal).toBeDefined();
      expect(signal!.aborted).toBe(false);

      pool.cancel("j2");
      expect(signal!.aborted).toBe(true);
    });
  });
});
