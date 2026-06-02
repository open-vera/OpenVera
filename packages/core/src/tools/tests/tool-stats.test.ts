import { describe, it, expect, beforeEach } from "vitest";
import { ToolStatsCollector } from "../tool-stats.js";
import type { ToolResult } from "../types.js";

function okResult(): ToolResult {
  return { ok: true, content: "success" };
}

function errResult(): ToolResult {
  return { ok: false, content: "fail", error: { code: "EXEC_ERROR", message: "fail", retryable: false } };
}

describe("ToolStatsCollector", () => {
  let collector: ToolStatsCollector;

  beforeEach(() => {
    collector = new ToolStatsCollector();
  });

  // ── constructor ────────────────────────────────────────────────────────────

  describe("constructor", () => {
    it("uses default maxRecords of 1000", () => {
      const c = new ToolStatsCollector();
      expect(c.size).toBe(0);
    });

    it("accepts custom maxRecords", () => {
      const c = new ToolStatsCollector(5);
      expect(c.size).toBe(0);
    });
  });

  // ── record ─────────────────────────────────────────────────────────────────

  describe("record", () => {
    it("stores a single record", () => {
      collector.record("bash", { cmd: "ls" }, okResult(), 100, "s1");
      expect(collector.size).toBe(1);
    });

    it("stores multiple records", () => {
      collector.record("bash", {}, okResult(), 50, "s1");
      collector.record("read", {}, okResult(), 30, "s1");
      expect(collector.size).toBe(2);
    });

    it("evicts oldest records when over maxRecords", () => {
      const c = new ToolStatsCollector(3);
      c.record("a", {}, okResult(), 10, "s1");
      c.record("b", {}, okResult(), 20, "s1");
      c.record("c", {}, okResult(), 30, "s1");
      c.record("d", {}, okResult(), 40, "s1");
      expect(c.size).toBe(3);
      const names = c.getRecords().map((r) => r.toolName);
      expect(names).toEqual(["b", "c", "d"]);
    });

    it("evicts multiple records when adding many at once over limit", () => {
      const c = new ToolStatsCollector(2);
      c.record("a", {}, okResult(), 10, "s1");
      c.record("b", {}, okResult(), 20, "s1");
      c.record("c", {}, okResult(), 30, "s1");
      c.record("d", {}, okResult(), 40, "s1");
      expect(c.size).toBe(2);
      const names = c.getRecords().map((r) => r.toolName);
      expect(names).toEqual(["c", "d"]);
    });

    it("evicts oldest when adding > 1000 records (default maxRecords)", () => {
      // Use default maxRecords of 1000
      const c = new ToolStatsCollector();
      // Add 1003 records — first 3 should be evicted
      for (let i = 0; i < 1003; i++) {
        c.record(`tool-${i}`, { idx: i }, okResult(), 10, "s1");
      }
      expect(c.size).toBe(1000);
      const records = c.getRecords();
      // Oldest record should be tool-3 (0,1,2 evicted)
      expect(records[0]!.toolName).toBe("tool-3");
      expect(records[0]!.args).toEqual({ idx: 3 });
      // Newest record should be tool-1002
      expect(records[999]!.toolName).toBe("tool-1002");
    });

    it("preserves different session IDs in records", () => {
      collector.record("bash", { cmd: "ls" }, okResult(), 10, "session-alpha");
      collector.record("bash", { cmd: "pwd" }, okResult(), 20, "session-beta");
      collector.record("read", { path: "/f" }, okResult(), 30, "session-gamma");

      const records = collector.getRecords();
      expect(records[0]!.sessionId).toBe("session-alpha");
      expect(records[1]!.sessionId).toBe("session-beta");
      expect(records[2]!.sessionId).toBe("session-gamma");
    });

    it("preserves args exactly as provided", () => {
      const args = { cmd: "echo hello", timeout: 5000, env: { DEBUG: "true" } };
      collector.record("bash", args, okResult(), 100, "s1");
      expect(collector.getRecords()[0]!.args).toEqual(args);
    });
  });

  // ── getStats ───────────────────────────────────────────────────────────────

  describe("getStats", () => {
    it("returns all zeros for a tool with no records", () => {
      const stats = collector.getStats("nonexistent");
      expect(stats.totalCalls).toBe(0);
      expect(stats.successCount).toBe(0);
      expect(stats.errorCount).toBe(0);
      expect(stats.avgDurationMs).toBe(0);
      expect(stats.p50DurationMs).toBe(0);
      expect(stats.errorRate).toBe(0);
      expect(stats.lastCalledAt).toBeNull();
    });

    it("returns correct stats for a specific tool", () => {
      collector.record("bash", {}, okResult(), 100, "s1");
      collector.record("bash", {}, errResult(), 200, "s1");
      collector.record("read", {}, okResult(), 50, "s1");

      const stats = collector.getStats("bash");
      expect(stats.totalCalls).toBe(2);
      expect(stats.successCount).toBe(1);
      expect(stats.errorCount).toBe(1);
      expect(stats.errorRate).toBe(0.5);
      expect(stats.avgDurationMs).toBe(150);
    });

    it("returns correct percentiles for a specific tool with many records", () => {
      // Add 100 records with durations 1..100
      for (let i = 1; i <= 100; i++) {
        collector.record("bash", {}, okResult(), i, "s1");
      }
      const stats = collector.getStats("bash");
      expect(stats.totalCalls).toBe(100);
      expect(stats.successCount).toBe(100);
      expect(stats.errorCount).toBe(0);
      expect(stats.avgDurationMs).toBe(50.5);
      // p50 = sorted[ceil(0.5*100)-1] = sorted[49] = 50
      expect(stats.p50DurationMs).toBe(50);
      // p95 = sorted[ceil(0.95*100)-1] = sorted[94] = 95
      expect(stats.p95DurationMs).toBe(95);
      // p99 = sorted[ceil(0.99*100)-1] = sorted[98] = 99
      expect(stats.p99DurationMs).toBe(99);
    });

    it("returns lastCalledAt for a specific tool", () => {
      const before = Date.now();
      collector.record("bash", {}, okResult(), 10, "s1");
      collector.record("read", {}, okResult(), 10, "s1");
      collector.record("bash", {}, okResult(), 20, "s1");
      const stats = collector.getStats("bash");
      expect(stats.lastCalledAt).toBeGreaterThanOrEqual(before);
      // The last "bash" call should be the 3rd record
      expect(stats.lastCalledAt).toBe(
        collector.getRecords({ toolName: "bash" })[1]!.timestamp
      );
    });
  });

  // ── getAllStats ─────────────────────────────────────────────────────────────

  describe("getAllStats", () => {
    it("returns all zeros when empty", () => {
      const stats = collector.getAllStats();
      expect(stats.totalCalls).toBe(0);
      expect(stats.successCount).toBe(0);
      expect(stats.errorCount).toBe(0);
      expect(stats.avgDurationMs).toBe(0);
      expect(stats.lastCalledAt).toBeNull();
    });

    it("returns aggregate stats across all tools", () => {
      collector.record("a", {}, okResult(), 100, "s1");
      collector.record("b", {}, errResult(), 300, "s1");

      const stats = collector.getAllStats();
      expect(stats.totalCalls).toBe(2);
      expect(stats.successCount).toBe(1);
      expect(stats.errorCount).toBe(1);
      expect(stats.avgDurationMs).toBe(200);
      expect(stats.errorRate).toBe(0.5);
    });

    it("aggregates across multiple sessions", () => {
      collector.record("bash", {}, okResult(), 100, "session-1");
      collector.record("bash", {}, okResult(), 200, "session-2");
      collector.record("read", {}, errResult(), 300, "session-3");

      const stats = collector.getAllStats();
      expect(stats.totalCalls).toBe(3);
      expect(stats.successCount).toBe(2);
      expect(stats.errorCount).toBe(1);
      expect(stats.avgDurationMs).toBe(200);
    });

    it("returns zeros after clear", () => {
      collector.record("t", {}, okResult(), 100, "s1");
      collector.clear();
      const stats = collector.getAllStats();
      expect(stats.totalCalls).toBe(0);
      expect(stats.successCount).toBe(0);
      expect(stats.errorCount).toBe(0);
      expect(stats.avgDurationMs).toBe(0);
      expect(stats.lastCalledAt).toBeNull();
    });
  });

  // ── getRecords ─────────────────────────────────────────────────────────────

  describe("getRecords", () => {
    beforeEach(() => {
      collector.record("bash", { cmd: "ls" }, okResult(), 10, "s1");
      collector.record("read", { path: "/f" }, okResult(), 20, "s1");
      collector.record("bash", { cmd: "pwd" }, okResult(), 30, "s2");
    });

    it("returns all records with no filter", () => {
      expect(collector.getRecords()).toHaveLength(3);
    });

    it("filters by toolName", () => {
      const records = collector.getRecords({ toolName: "bash" });
      expect(records).toHaveLength(2);
      expect(records.every((r) => r.toolName === "bash")).toBe(true);
    });

    it("filters by limit", () => {
      const records = collector.getRecords({ limit: 2 });
      expect(records).toHaveLength(2);
      // last 2 records
      expect(records[0]!.args).toEqual({ path: "/f" });
      expect(records[1]!.args).toEqual({ cmd: "pwd" });
    });

    it("filters by both toolName and limit", () => {
      const records = collector.getRecords({ toolName: "bash", limit: 1 });
      expect(records).toHaveLength(1);
      expect(records[0]!.args).toEqual({ cmd: "pwd" });
    });

    it("returns empty array when toolName matches nothing", () => {
      expect(collector.getRecords({ toolName: "nonexistent" })).toHaveLength(0);
    });

    it("returns all records when limit exceeds available count", () => {
      const records = collector.getRecords({ limit: 100 });
      expect(records).toHaveLength(3);
    });

    it("returns records preserving sessionId", () => {
      const records = collector.getRecords();
      expect(records[0]!.sessionId).toBe("s1");
      expect(records[2]!.sessionId).toBe("s2");
    });
  });

  // ── topTools ───────────────────────────────────────────────────────────────

  describe("topTools", () => {
    it("returns empty array when no records", () => {
      expect(collector.topTools()).toEqual([]);
    });

    it("returns tools sorted by call count descending", () => {
      collector.record("read", {}, okResult(), 10, "s1");
      collector.record("bash", {}, okResult(), 10, "s1");
      collector.record("bash", {}, okResult(), 10, "s1");
      collector.record("bash", {}, okResult(), 10, "s1");

      const top = collector.topTools();
      expect(top[0]!.name).toBe("bash");
      expect(top[0]!.calls).toBe(3);
      expect(top[1]!.name).toBe("read");
      expect(top[1]!.calls).toBe(1);
    });

    it("limits to N tools", () => {
      collector.record("a", {}, okResult(), 10, "s1");
      collector.record("b", {}, okResult(), 10, "s1");
      collector.record("c", {}, okResult(), 10, "s1");

      const top = collector.topTools(2);
      expect(top).toHaveLength(2);
    });

    it("computes error rate correctly", () => {
      collector.record("bash", {}, okResult(), 10, "s1");
      collector.record("bash", {}, errResult(), 10, "s1");
      collector.record("bash", {}, errResult(), 10, "s1");

      const top = collector.topTools();
      expect(top[0]!.errorRate).toBeCloseTo(2 / 3);
    });

    it("defaults n to 10", () => {
      for (let i = 0; i < 15; i++) {
        collector.record(`tool${i}`, {}, okResult(), 10, "s1");
      }
      const top = collector.topTools();
      expect(top).toHaveLength(10);
    });

    it("returns all tools when fewer than n", () => {
      collector.record("bash", {}, okResult(), 10, "s1");
      collector.record("read", {}, okResult(), 10, "s1");

      const top = collector.topTools(5);
      expect(top).toHaveLength(2);
      expect(top[0]!.name).toBe("bash");
      expect(top[1]!.name).toBe("read");
    });

    it("returns tools with errorRate 0 when all succeed", () => {
      collector.record("bash", {}, okResult(), 10, "s1");
      collector.record("bash", {}, okResult(), 10, "s1");

      const top = collector.topTools();
      expect(top[0]!.errorRate).toBe(0);
    });

    it("sorts tools with same call count stably", () => {
      collector.record("tool-a", {}, okResult(), 10, "s1");
      collector.record("tool-b", {}, okResult(), 10, "s1");

      const top = collector.topTools();
      expect(top).toHaveLength(2);
      expect(top[0]!.calls).toBe(1);
      expect(top[1]!.calls).toBe(1);
    });
  });

  // ── clear ──────────────────────────────────────────────────────────────────

  describe("clear", () => {
    it("empties all records", () => {
      collector.record("bash", {}, okResult(), 10, "s1");
      collector.record("read", {}, okResult(), 20, "s1");
      collector.clear();
      expect(collector.size).toBe(0);
      expect(collector.getRecords()).toHaveLength(0);
    });
  });

  // ── size getter ────────────────────────────────────────────────────────────

  describe("size", () => {
    it("returns 0 when empty", () => {
      expect(collector.size).toBe(0);
    });

    it("returns correct count after records", () => {
      collector.record("a", {}, okResult(), 10, "s1");
      collector.record("b", {}, okResult(), 20, "s1");
      expect(collector.size).toBe(2);
    });
  });

  // ── computeStats (via getAllStats) ──────────────────────────────────────────

  describe("computeStats", () => {
    it("returns correct percentiles", () => {
      // durations: 10, 20, 30, 40, 50, 60, 70, 80, 90, 100
      for (let i = 1; i <= 10; i++) {
        collector.record("t", {}, okResult(), i * 10, "s1");
      }
      const stats = collector.getAllStats();
      expect(stats.totalCalls).toBe(10);
      expect(stats.avgDurationMs).toBe(55);
      // p50: ceil(0.5 * 10) - 1 = 4 → sorted[4] = 50
      expect(stats.p50DurationMs).toBe(50);
      // p95: ceil(0.95 * 10) - 1 = 9 → sorted[9] = 100
      expect(stats.p95DurationMs).toBe(100);
      // p99: ceil(0.99 * 10) - 1 = 9 → sorted[9] = 100
      expect(stats.p99DurationMs).toBe(100);
    });

    it("handles single record percentiles", () => {
      collector.record("t", {}, okResult(), 42, "s1");
      const stats = collector.getAllStats();
      expect(stats.p50DurationMs).toBe(42);
      expect(stats.p95DurationMs).toBe(42);
      expect(stats.p99DurationMs).toBe(42);
      expect(stats.avgDurationMs).toBe(42);
    });

    it("lastCalledAt equals the last record's timestamp", () => {
      collector.record("t", {}, okResult(), 10, "s1");
      const before = Date.now();
      collector.record("t", {}, okResult(), 20, "s1");
      const stats = collector.getAllStats();
      expect(stats.lastCalledAt).toBeGreaterThanOrEqual(before);
    });

    it("errorRate is 0 when all calls succeed", () => {
      collector.record("t", {}, okResult(), 10, "s1");
      collector.record("t", {}, okResult(), 20, "s1");
      expect(collector.getAllStats().errorRate).toBe(0);
    });

    it("errorRate is 1 when all calls fail", () => {
      collector.record("t", {}, errResult(), 10, "s1");
      collector.record("t", {}, errResult(), 20, "s1");
      expect(collector.getAllStats().errorRate).toBe(1);
    });
  });

  // ── integration scenarios ──────────────────────────────────────────────────

  describe("integration", () => {
    it("handles mixed tools, mixed success/failure across sessions", () => {
      // Simulate a realistic multi-tool session
      collector.record("read", { path: "/a.ts" }, okResult(), 12, "s1");
      collector.record("grep", { pattern: "foo" }, okResult(), 8, "s1");
      collector.record("bash", { cmd: "tsc" }, errResult(), 1500, "s1");
      collector.record("write", { path: "/b.ts" }, okResult(), 45, "s1");

      collector.record("read", { path: "/b.ts" }, okResult(), 11, "s2");
      collector.record("grep", { pattern: "bar" }, errResult(), 7, "s2");
      collector.record("bash", { cmd: "npm test" }, okResult(), 3200, "s2");

      // Overall stats
      const all = collector.getAllStats();
      expect(all.totalCalls).toBe(7);
      expect(all.successCount).toBe(5);
      expect(all.errorCount).toBe(2);

      // Per-tool stats
      expect(collector.getStats("read").totalCalls).toBe(2);
      expect(collector.getStats("read").successCount).toBe(2);
      expect(collector.getStats("grep").totalCalls).toBe(2);
      expect(collector.getStats("grep").successCount).toBe(1);
      expect(collector.getStats("bash").totalCalls).toBe(2);
      expect(collector.getStats("bash").successCount).toBe(1);

      // Top tools
      const top = collector.topTools(3);
      expect(top).toHaveLength(3);
      // All tools have 2 calls each
      expect(top.every((t) => t.calls === 2)).toBe(true);

      // Records filtered by tool
      expect(collector.getRecords({ toolName: "read" })).toHaveLength(2);
      expect(collector.getRecords({ toolName: "bash", limit: 1 })).toHaveLength(1);

      // Session ID isolation in records
      const s1Records = collector.getRecords().filter((r) => r.sessionId === "s1");
      expect(s1Records).toHaveLength(4);

      collector.clear();
      expect(collector.size).toBe(0);
      expect(collector.getAllStats().totalCalls).toBe(0);
      expect(collector.topTools()).toEqual([]);
    });
  });
});
