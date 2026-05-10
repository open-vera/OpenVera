/**
 * Tests for SubagentPool double-count bug in processQueue().
 *
 * Bug: when a queued job is promoted to running via processQueue(),
 * runningCount is incremented again even though the job was already
 * counted at submit() time. This inflates runningCount.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { SubagentPool } from "../src/agent/subagent-pool.js";

describe("SubagentPool processQueue double-count bug", () => {
  describe("BUG: runningCount inflated when queue is promoted", () => {
    it("runningCount should equal min(total, maxConcurrent) after submits", () => {
      // maxConcurrent=1, submit 3 jobs: j1 runs, j2+j3 queue
      const pool = new SubagentPool({ maxConcurrent: 1, maxQueue: 10 });
      pool.submit("j1", "coder", "task 1");
      pool.submit("j2", "coder", "task 2");
      pool.submit("j3", "coder", "task 3");

      // runningCount should be 1 (only j1), not 3
      // BUG: current impl increments runningCount at submit() for EVERY job,
      // then processQueue() increments again for promoted queued jobs
      const s = pool.status();
      expect(s.running).toBe(1);
      expect(s.queued).toBe(2);
      expect(s.total).toBe(3);
    });

    it("runningCount stays correct after complete() depletes running slot", () => {
      const pool = new SubagentPool({ maxConcurrent: 1, maxQueue: 10 });
      pool.submit("j1", "coder", "task 1"); // runs
      pool.submit("j2", "coder", "task 2"); // queued
      pool.submit("j3", "coder", "task 3"); // queued

      pool.complete("j1");
      // j2 should be promoted → running=1, queued=1
      const s1 = pool.status();
      expect(s1.running).toBe(1);
      expect(s1.queued).toBe(1);

      pool.complete("j2");
      // j3 promoted → running=1, queued=0
      const s2 = pool.status();
      expect(s2.running).toBe(1);
      expect(s2.queued).toBe(0);

      pool.complete("j3");
      // all done → running=0, queued=0
      const s3 = pool.status();
      expect(s3.running).toBe(0);
      expect(s3.queued).toBe(0);
    });

    it("cancel on queued job should not affect running count", () => {
      const pool = new SubagentPool({ maxConcurrent: 1, maxQueue: 10 });
      pool.submit("j1", "coder", "task 1"); // runs
      pool.submit("j2", "coder", "task 2"); // queued
      pool.submit("j3", "coder", "task 3"); // queued

      // Cancel j2 (queued)
      pool.cancel("j2");
      const s = pool.status();
      // running should still be 1 (j1), queued should be 1 (j3)
      expect(s.running).toBe(1);
      expect(s.queued).toBe(1);

      // Now complete j1 — j3 should be promoted, running=1
      pool.complete("j1");
      const s2 = pool.status();
      expect(s2.running).toBe(1);
      expect(s2.queued).toBe(0);
    });

    it("maxConcurrent=3, total=6: running should cap at 3", () => {
      const pool = new SubagentPool({ maxConcurrent: 3, maxQueue: 10 });
      for (let i = 1; i <= 6; i++) {
        pool.submit(`j${i}`, "coder", `task ${i}`);
      }

      const s = pool.status();
      expect(s.running).toBe(3);
      expect(s.queued).toBe(3);
    });

    it("queue full rejection still works after bug", () => {
      const pool = new SubagentPool({ maxConcurrent: 2, maxQueue: 3 });
      // 2 running + 3 queued = 5 = maxTotal
      pool.submit("j1", "coder", "task");
      pool.submit("j2", "coder", "task");
      pool.submit("j3", "coder", "task");
      pool.submit("j4", "coder", "task");
      pool.submit("j5", "coder", "task");

      // 6th should throw
      expect(() => pool.submit("j6", "coder", "task")).toThrow();
    });

    it("submit race pattern: complete then submit fills queue correctly", () => {
      const pool = new SubagentPool({ maxConcurrent: 2, maxQueue: 5 });
      pool.submit("j1", "coder", "task");
      pool.submit("j2", "coder", "task");
      pool.submit("j3", "coder", "task"); // queued

      // Complete j1, freeing a slot
      pool.complete("j1");
      // j3 promoted (but already counted in running → double-count bug manifests here)
      const s = pool.status();
      expect(s.running).toBe(2); // j2 + j3
      expect(s.queued).toBe(0);

      // Submit new job while at capacity
      pool.submit("j4", "coder", "task");
      const s2 = pool.status();
      expect(s2.running).toBe(2);
      expect(s2.queued).toBe(1);
    });
  });
});