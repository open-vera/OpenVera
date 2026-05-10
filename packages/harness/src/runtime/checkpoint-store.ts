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

import { mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { FlowCheckpoint } from "@open-vera/core/types";

export interface CheckpointStoreOptions {
  /** Root directory for checkpoint files. Defaults to ~/.vera/checkpoints */
  checkpointsDir: string;
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

  constructor(options: CheckpointStoreOptions) {
    this.dir = options.checkpointsDir;
    mkdirSync(this.dir, { recursive: true });
  }

  /**
   * Persist a checkpoint to disk. Append-only write.
   */
  save(checkpoint: FlowCheckpoint): void {
    const filePath = this.filePath(checkpoint.flowId);
    const line = JSON.stringify(checkpoint) + "\n";
    writeFileSync(filePath, line, { flag: "a" });
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
