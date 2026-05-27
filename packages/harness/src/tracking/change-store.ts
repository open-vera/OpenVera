/**
 * Change Store — JSONL-based storage for agent change records.
 *
 * Stores records in daily files: ~/.vera/changes/YYYY-MM-DD.jsonl
 * Supports querying by time range, agent, tool, and file path.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ── Types ────────────────────────────────────────────────────────────────────

export interface ChangeRecord {
  timestamp: string;
  agentId: string;
  toolName: string;
  args: string;
  success: boolean;
  filesChanged: string[];
  summary: string;
  resultPreview?: string;
  error?: string;
}

export interface ChangeStoreOptions {
  /** Directory to store change logs (default: ~/.vera/changes) */
  storeDir?: string;
  /** Days to keep records before archiving (default: 30) */
  retentionDays?: number;
}

// ── Change Store ─────────────────────────────────────────────────────────────

export class ChangeStore {
  private storeDir: string;
  private retentionDays: number;

  constructor(options: ChangeStoreOptions = {}) {
    this.storeDir = options.storeDir ?? join(homedir(), ".vera", "changes");
    this.retentionDays = options.retentionDays ?? 30;
  }

  /**
   * Initialize the store directory.
   */
  async initialize(): Promise<void> {
    if (!existsSync(this.storeDir)) {
      mkdirSync(this.storeDir, { recursive: true });
    }
  }

  /**
   * Append a change record to today's log file.
   */
  async append(record: ChangeRecord): Promise<void> {
    const filePath = this.getDayFilePath(record.timestamp);
    const line = JSON.stringify(record) + "\n";

    try {
      writeFileSync(filePath, line, { flag: "a" });
    } catch {
      // If write fails, try creating directory first
      mkdirSync(this.storeDir, { recursive: true });
      writeFileSync(filePath, line, { flag: "a" });
    }
  }

  /**
   * Query change records with optional filters.
   */
  async query(options: {
    since?: string;
    until?: string;
    agentId?: string;
    toolName?: string;
    filePath?: string;
    limit?: number;
  }): Promise<ChangeRecord[]> {
    const { since, until, agentId, toolName, filePath, limit = 100 } = options;

    // Determine which day files to scan
    const dayFiles = this.getDayFilesInRange(since, until);
    const results: ChangeRecord[] = [];

    for (const file of dayFiles) {
      const records = this.readDayFile(file);
      for (const record of records) {
        // Apply filters
        if (since && record.timestamp < since) continue;
        if (until && record.timestamp > until) continue;
        if (agentId && record.agentId !== agentId) continue;
        if (toolName && record.toolName !== toolName) continue;
        if (filePath && !record.filesChanged.includes(filePath)) continue;

        results.push(record);
        if (results.length >= limit) return results;
      }
    }

    return results;
  }

  /**
   * Get statistics about stored records.
   */
  async getStats(): Promise<{
    totalRecords: number;
    dayCount: number;
    oldestRecord?: string;
    newestRecord?: string;
  }> {
    const files = this.listDayFiles();
    let totalRecords = 0;
    let oldest: string | undefined;
    let newest: string | undefined;

    for (const file of files) {
      const records = this.readDayFile(file);
      totalRecords += records.length;
      if (records.length > 0) {
        const first = records[0].timestamp;
        const last = records[records.length - 1].timestamp;
        if (!oldest || first < oldest) oldest = first;
        if (!newest || last > newest) newest = last;
      }
    }

    return {
      totalRecords,
      dayCount: files.length,
      oldestRecord: oldest,
      newestRecord: newest,
    };
  }

  /**
   * Archive old records (older than retentionDays).
   */
  async archive(): Promise<number> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - this.retentionDays);
    const cutoffStr = cutoff.toISOString().slice(0, 10);

    const files = this.listDayFiles();
    let archived = 0;

    for (const file of files) {
      const dateStr = file.replace(".jsonl", "");
      if (dateStr < cutoffStr) {
        const archivePath = join(this.storeDir, "archive", file);
        const archiveDir = join(this.storeDir, "archive");
        if (!existsSync(archiveDir)) {
          mkdirSync(archiveDir, { recursive: true });
        }

        try {
          const content = readFileSync(join(this.storeDir, file), "utf-8");
          writeFileSync(archivePath, content, { flag: "a" });
          // Remove original
          const { unlinkSync } = require("node:fs");
          unlinkSync(join(this.storeDir, file));
          archived++;
        } catch {
          // Skip files that can't be archived
        }
      }
    }

    return archived;
  }

  // ── Internal ─────────────────────────────────────────────────────────────

  private getDayFilePath(timestamp: string): string {
    const dateStr = timestamp.slice(0, 10); // YYYY-MM-DD
    return join(this.storeDir, `${dateStr}.jsonl`);
  }

  private getDayFilesInRange(since?: string, until?: string): string[] {
    const files = this.listDayFiles();
    const sinceDate = since ? since.slice(0, 10) : "0000-00-00";
    const untilDate = until ? until.slice(0, 10) : "9999-99-99";

    return files.filter((f) => {
      const dateStr = f.replace(".jsonl", "");
      return dateStr >= sinceDate && dateStr <= untilDate;
    });
  }

  private listDayFiles(): string[] {
    try {
      return readdirSync(this.storeDir)
        .filter((f) => f.match(/^\d{4}-\d{2}-\d{2}\.jsonl$/))
        .sort();
    } catch {
      return [];
    }
  }

  private readDayFile(filename: string): ChangeRecord[] {
    try {
      const content = readFileSync(join(this.storeDir, filename), "utf-8");
      return content
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line) as ChangeRecord;
          } catch {
            return null;
          }
        })
        .filter((r): r is ChangeRecord => r !== null);
    } catch {
      return [];
    }
  }
}
