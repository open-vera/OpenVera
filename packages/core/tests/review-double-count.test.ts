/**
 * Tests for review findings — Bug #1: SubagentPool double-count.
 *
 * Bug: processQueue() was incrementing runningCount again for queued jobs
 * that were already counted at submit time. This inflated runningCount.
 *
 * Fix: Only increment runningCount for jobs that were NOT already counted
 * (i.e., queued jobs that are being promoted to running for the first time).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { SubagentPool } from "../src/agent/subagent-pool.js";

describe("SubagentPool — double-count fix", () => {
  it("should NOT double-count when a queued job is promoted", () => {
    const pool = new SubagentPool({ maxConcurrent: 1, maxQueue: 5 });
    pool.submit("j1", "coder", "task 1");
    pool.submit("j2", "coder", "task 2"); // queued

    const s1 = pool.status();
    expect(s1.running).toBe(1); // only j1 is running
    expect(s1.queued).toBe(1); // j2 is queued

    // Complete j1 → j2 should be promoted, running should go back to 1, not 2
    pool.complete("j1", "done");
    const s2 = pool.status();
    expect(s2.running).toBe(1); // j2 promoted to running
    expect(s2.queued).toBe(0);
  });

  it("should handle fill-to-capacity then exhaust queue correctly", () => {
    const pool = new SubagentPool({ maxConcurrent: 2, maxQueue: 2 });
    pool.submit("j1", "coder", "task");
    pool.submit("j2", "coder", "task");
    pool.submit("j3", "coder", "task"); // queued
    pool.submit("j4", "coder", "task"); // queued

    const s1 = pool.status();
    expect(s1.running).toBe(2);
    expect(s1.queued).toBe(2);
    expect(s1.total).toBe(4);

    // Complete two, remaining two promoted — running should be exactly 2
    pool.complete("j1", "done");
    pool.complete("j2", "done");
    const s2 = pool.status();
    expect(s2.running).toBe(2);
    expect(s2.queued).toBe(0);
  });

  it("should count only active slots when maxConcurrent is 0", () => {
    const pool = new SubagentPool({ maxConcurrent: 0, maxQueue: 3 });
    pool.submit("j1", "coder", "task");
    pool.submit("j2", "coder", "task");

    // No slots for actual running, everything queues
    const s = pool.status();
    expect(s.running).toBe(0);
    expect(s.queued).toBe(2);
    expect(s.total).toBe(2);
  });

  it("should throw QueueFullError when total jobs exceed capacity", () => {
    const pool = new SubagentPool({ maxConcurrent: 1, maxQueue: 1 });
    pool.submit("j1", "coder", "task");
    pool.submit("j2", "coder", "task");
    expect(() => pool.submit("j3", "coder", "task")).toThrow("Queue is full");
  });
});