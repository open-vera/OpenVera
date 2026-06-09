/**
 * ToolStatsCollector — tracks per-tool execution metrics.
 *
 * Collects call records and computes aggregate statistics
 * (total calls, success/error counts, latency percentiles, error rate).
 */

import type { ToolExecutionRecord, ToolStats, ToolResult } from "./types.js";

export class ToolStatsCollector {
  private readonly records: ToolExecutionRecord[] = [];
  private readonly maxRecords: number;

  constructor(maxRecords = 1_000) {
    this.maxRecords = maxRecords;
  }

  record(
    toolName: string,
    args: Record<string, unknown>,
    result: ToolResult,
    durationMs: number,
    sessionId: string
  ): void {
    this.records.push({
      toolName,
      args,
      result,
      durationMs,
      timestamp: Date.now(),
      sessionId,
    });

    // Evict oldest if over limit
    if (this.records.length > this.maxRecords) {
      this.records.splice(0, this.records.length - this.maxRecords);
    }
  }

  /** Get stats for a specific tool. */
  getStats(toolName: string): ToolStats {
    const toolRecords = this.records.filter((r) => r.toolName === toolName);
    return this.computeStats(toolRecords);
  }

  /** Get aggregate stats across all tools. */
  getAllStats(): ToolStats {
    return this.computeStats(this.records);
  }

  /** Get all recorded calls, optionally filtered. */
  getRecords(filter?: { toolName?: string; limit?: number }): ToolExecutionRecord[] {
    let filtered = this.records;
    if (filter?.toolName) {
      filtered = filtered.filter((r) => r.toolName === filter.toolName);
    }
    if (filter?.limit) {
      filtered = filtered.slice(-filter.limit);
    }
    return filtered;
  }

  /** Get top N tools by call count. */
  topTools(n = 10): Array<{ name: string; calls: number; errorRate: number }> {
    const counts = new Map<string, { calls: number; errors: number }>();
    for (const r of this.records) {
      const entry = counts.get(r.toolName) ?? { calls: 0, errors: 0 };
      entry.calls++;
      if (!r.result.ok) entry.errors++;
      counts.set(r.toolName, entry);
    }

    return [...counts.entries()]
      .map(([name, { calls, errors }]) => ({
        name,
        calls,
        errorRate: calls > 0 ? errors / calls : 0,
      }))
      .sort((a, b) => b.calls - a.calls)
      .slice(0, n);
  }

  /** Clear all records. */
  clear(): void {
    this.records.length = 0;
  }

  /** Total number of records. */
  get size(): number {
    return this.records.length;
  }

  private computeStats(records: ToolExecutionRecord[]): ToolStats {
    if (records.length === 0) {
      return {
        totalCalls: 0,
        successCount: 0,
        errorCount: 0,
        avgDurationMs: 0,
        p50DurationMs: 0,
        p95DurationMs: 0,
        p99DurationMs: 0,
        errorRate: 0,
        lastCalledAt: null,
      };
    }

    const durations = records.map((r) => r.durationMs).sort((a, b) => a - b);
    const successCount = records.filter((r) => r.result.ok).length;
    const errorCount = records.length - successCount;

    return {
      totalCalls: records.length,
      successCount,
      errorCount,
      avgDurationMs: durations.reduce((a, b) => a + b, 0) / durations.length,
      p50DurationMs: percentile(durations, 0.5),
      p95DurationMs: percentile(durations, 0.95),
      p99DurationMs: percentile(durations, 0.99),
      errorRate: records.length > 0 ? errorCount / records.length : 0,
      lastCalledAt: records[records.length - 1]!.timestamp,
    };
  }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil(p * sorted.length) - 1;
  return sorted[Math.max(0, idx)]!;
}
