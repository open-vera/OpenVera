/**
 * Checkpoint Store — Persistent JSONL-based checkpoint storage for Flow recovery.
 *
 * Each flow's checkpoints are stored in a dedicated JSONL file:
 *   <checkpointsDir>/<flowId>.checkpoints.jsonl
 *
 * Design:
 * - Append-only writes (crash-safe)
 * - Each line is a complete FlowCheckpoint JSON
 * - loadLatest() reads the last non-empty line
 * - load(checkpointId) scans for matching ID
 */

import { mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { FlowCheckpoint } from "@open-vera/core/types";

export interface CheckpointStoreOptions {
  /** Root directory for checkpoint files. Defaults to ~/.vera/checkpoints */
  checkpointsDir: string;

  /**
   * Maximum number of checkpoints to keep per flow during compaction.
   * When set, auto-compaction triggers after `compactAfter` total lines.
   * Only the latest N entries (by position in file) are retained; older
   * duplicate IDs and excess entries are pruned.
   *
   * If omitted or 0, compaction is manual-only (call `compact()` explicitly).
   */
  compactToKeep?: number;

  /**
   * Auto-compact when total line count exceeds this threshold.
   * Defaults to `compactToKeep * 3` when `compactToKeep` is set, otherwise disabled.
   * Set to `Infinity` to disable auto-compaction while keeping `compactToKeep` for manual calls.
   */
  compactAfter?: number;
}

export interface CheckpointIndexEntry {
  checkpointId: string;
  flowId: string;
  state: string;
  createdAt: string;
  activeStepId?: string;
}

/**
 * Append-only JSONL checkpoint store.
 */
export class CheckpointStore {
  private readonly dir: string;
  private readonly compactToKeep: number;
  private readonly compactAfter: number;

  constructor(options: CheckpointStoreOptions) {
    this.dir = options.checkpointsDir;
    this.compactToKeep = options.compactToKeep ?? 0;
    this.compactAfter =
      options.compactAfter ??
      (this.compactToKeep > 0 ? this.compactToKeep * 3 : Infinity);
    mkdirSync(this.dir, { recursive: true });
  }

  /**
   * Persist a checkpoint to disk. Append-only write.
   * Auto-compacts when the total line count exceeds `compactAfter`.
   */
  save(checkpoint: FlowCheckpoint): void {
    const filePath = this.filePath(checkpoint.flowId);
    const line = JSON.stringify(checkpoint) + "\n";
    writeFileSync(filePath, line, { flag: "a" });

    // Auto-compaction check (only when compactToKeep is configured)
    if (this.compactToKeep > 0) {
      this.maybeAutoCompact(checkpoint.flowId);
    }
  }

  /**
   * Load the most recent checkpoint for a given flow.
   * Returns null if no checkpoints exist.
   */
  loadLatest(flowId: string): FlowCheckpoint | null {
    const filePath = this.filePath(flowId);
    try {
      const raw = readFileSync(filePath, "utf-8");
      const lines = raw.trim().split("\n").filter(Boolean);
      // Scan from end, skip corrupt lines
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          return JSON.parse(lines[i]!) as FlowCheckpoint;
        } catch {
          // Skip corrupt line, try previous
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Load a specific checkpoint by ID.
   * Scans from the end (most recent first) for efficiency.
   * Skips corrupt/unparseable lines gracefully.
   */
  load(flowId: string, checkpointId: string): FlowCheckpoint | null {
    const filePath = this.filePath(flowId);
    try {
      const raw = readFileSync(filePath, "utf-8");
      const lines = raw.trim().split("\n").filter(Boolean);
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const cp = JSON.parse(lines[i]!) as FlowCheckpoint;
          if (cp.checkpointId === checkpointId) return cp;
        } catch {
          // Skip corrupt lines
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * List all checkpoint index entries for a flow (lightweight, no full data).
   */
  list(flowId: string): CheckpointIndexEntry[] {
    const filePath = this.filePath(flowId);
    try {
      const raw = readFileSync(filePath, "utf-8");
      const lines = raw.trim().split("\n").filter(Boolean);
      const entries: CheckpointIndexEntry[] = [];
      for (const line of lines) {
        try {
          const cp = JSON.parse(line) as FlowCheckpoint;
          entries.push({
            checkpointId: cp.checkpointId,
            flowId: cp.flowId,
            state: cp.state,
            activeStepId: cp.activeStepId,
            createdAt: cp.checkpointId,
          });
        } catch {
          // Skip corrupt lines
        }
      }
      return entries;
    } catch {
      return [];
    }
  }

  /**
   * List all flow IDs that have checkpoints.
   */
  listFlows(): string[] {
    try {
      return readdirSync(this.dir)
        .filter((f) => f.endsWith(".checkpoints.jsonl"))
        .map((f) => f.replace(".checkpoints.jsonl", ""));
    } catch {
      return [];
    }
  }

  /**
   * Compact a flow's checkpoint file:
   * 1. Removes corrupt/unparseable lines
   * 2. Deduplicates by checkpointId (keeps the latest occurrence)
   * 3. If `compactToKeep` is set, prunes to the last N entries
   *
   * Returns the number of lines removed.
   *
   * Uses atomic write: writes to a temp file then renames in place.
   */
  compact(flowId: string): number {
    const filePath = this.filePath(flowId);
    let raw: string;
    try {
      raw = readFileSync(filePath, "utf-8");
    } catch {
      return 0;
    }

    const lines = raw.split("\n");
    const originalCount = lines.filter((l) => l.trim().length > 0).length;

    // Parse all valid lines, keeping the latest occurrence of each checkpointId
    const seen = new Map<string, FlowCheckpoint>();
    const order: string[] = []; // track insertion order for final ordering

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const cp = JSON.parse(trimmed) as FlowCheckpoint;
        const id = cp.checkpointId;
        if (!seen.has(id)) {
          order.push(id);
        }
        seen.set(id, cp);
      } catch {
        // Skip corrupt lines
      }
    }

    // Build the final list in order, applying keep limit
    let entries = order.map((id) => seen.get(id)!);

    if (this.compactToKeep > 0 && entries.length > this.compactToKeep) {
      entries = entries.slice(entries.length - this.compactToKeep);
    }

    const newContent = entries.map((cp) => JSON.stringify(cp)).join("\n") + (entries.length > 0 ? "\n" : "");

    // Atomic write: write to temp, rename over original
    const tmpPath = filePath + ".compacting";
    writeFileSync(tmpPath, newContent);
    renameSync(tmpPath, filePath);

    const newCount = entries.length;
    return originalCount - newCount;
  }

  /**
   * Compact all flows that have checkpoints.
   * Returns total lines removed across all flows.
   */
  compactAll(): number {
    let totalRemoved = 0;
    for (const flowId of this.listFlows()) {
      totalRemoved += this.compact(flowId);
    }
    return totalRemoved;
  }

  /**
   * Get the raw line count for a flow (including corrupt lines and duplicates).
   */
  lineCount(flowId: string): number {
    const filePath = this.filePath(flowId);
    try {
      const raw = readFileSync(filePath, "utf-8");
      return raw.split("\n").filter((l) => l.trim().length > 0).length;
    } catch {
      return 0;
    }
  }

  /**
   * Check if a flow's checkpoint file needs compaction.
   */
  needsCompaction(flowId: string): boolean {
    if (this.compactToKeep <= 0) return false;
    return this.lineCount(flowId) > this.compactAfter;
  }

  /**
   * Auto-compact if the line count exceeds the threshold.
   * Skipped silently if compactToKeep is 0 or if the threshold isn't exceeded.
   */
  private maybeAutoCompact(flowId: string): void {
    if (this.lineCount(flowId) > this.compactAfter) {
      this.compact(flowId);
    }
  }

  /**
   * Delete all checkpoints for a flow.
   */
  clear(flowId: string): void {
    const filePath = this.filePath(flowId);
    try {
      writeFileSync(filePath, "");
    } catch {
      // File may not exist; that's fine
    }
  }

  /**
   * Get the number of checkpoints for a flow.
   */
  count(flowId: string): number {
    return this.list(flowId).length;
  }

  private filePath(flowId: string): string {
    // Sanitize flowId for filesystem safety
    const safe = flowId.replace(/[^a-zA-Z0-9_-]/g, "_");
    return join(this.dir, `${safe}.checkpoints.jsonl`);
  }
}

/**
 * Generate a checkpoint ID with embedded timestamp.
 * Format: `cp-<timestamp>-<random4>`
 */
export function makeCheckpointId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 6);
  return `cp-${ts}-${rand}`;
}
