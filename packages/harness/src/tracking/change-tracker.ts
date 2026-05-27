/**
 * Change Tracker — Hook into tool execution to record file changes.
 *
 * Wraps ToolRegistry.execute() to automatically log every tool call,
 * extracting changed files and producing a structured change record.
 */

import type { ToolMiddleware, ToolResult, ToolContext } from "@open-vera/core/tools";
import { ChangeStore, type ChangeRecord } from "./change-store.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface ChangeTrackerOptions {
  /** Directory to store change logs (default: ~/.vera/changes) */
  storeDir?: string;
  /** Whether to track read-only tool calls (default: false) */
  trackReads?: boolean;
  /** Max length for result content stored (default: 500) */
  maxResultLength?: number;
  /** Agent ID to tag in records */
  agentId?: string;
}

// ── Change Tracker ───────────────────────────────────────────────────────────

export class ChangeTracker {
  private store: ChangeStore;
  private trackReads: boolean;
  private maxResultLength: number;
  private agentId: string;

  constructor(options: ChangeTrackerOptions = {}) {
    this.store = new ChangeStore({ storeDir: options.storeDir });
    this.trackReads = options.trackReads ?? false;
    this.maxResultLength = options.maxResultLength ?? 500;
    this.agentId = options.agentId ?? "agent";
  }

  /**
   * Create a ToolMiddleware that logs every tool call.
   */
  createMiddleware(): ToolMiddleware {
    return {
      name: "change-tracker",
      after: async (
        name: string,
        args: Record<string, unknown>,
        result: ToolResult,
        _ctx: ToolContext,
      ): Promise<ToolResult> => {
        // Skip read-only tools unless configured
        if (!this.trackReads && this.isReadOnlyTool(name)) {
          return result;
        }

        const record: ChangeRecord = {
          timestamp: new Date().toISOString(),
          agentId: this.agentId,
          toolName: name,
          args: this.truncate(JSON.stringify(args), 1000),
          success: result.ok,
          filesChanged: this.extractChangedFiles(name, args, result),
          summary: this.generateSummary(name, args, result),
          resultPreview: result.ok
            ? this.truncate(result.content, this.maxResultLength)
            : undefined,
          error: result.error?.message,
        };

        await this.store.append(record);
        return result;
      },
    };
  }

  /**
   * Initialize the change store.
   */
  async initialize(): Promise<void> {
    await this.store.initialize();
  }

  /**
   * Query change records.
   */
  async query(options: {
    since?: string;
    until?: string;
    agentId?: string;
    toolName?: string;
    filePath?: string;
    limit?: number;
  }): Promise<ChangeRecord[]> {
    return this.store.query(options);
  }

  /**
   * Get the underlying store.
   */
  getStore(): ChangeStore {
    return this.store;
  }

  /**
   * Generate a summary of changes for a given time period.
   * Useful for episodic memory or daily reports.
   */
  async generateSummary(options: {
    since?: string;
    until?: string;
  }): Promise<{
    totalCalls: number;
    successfulCalls: number;
    failedCalls: number;
    filesModified: string[];
    toolsUsed: Record<string, number>;
    summary: string;
  }> {
    const records = await this.store.query({
      since: options.since,
      until: options.until,
      limit: 10000,
    });

    const filesModified = new Set<string>();
    const toolsUsed: Record<string, number> = {};
    let successful = 0;
    let failed = 0;

    for (const record of records) {
      if (record.success) successful++;
      else failed++;

      for (const file of record.filesChanged) {
        filesModified.add(file);
      }

      toolsUsed[record.toolName] = (toolsUsed[record.toolName] ?? 0) + 1;
    }

    const topTools = Object.entries(toolsUsed)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name, count]) => `${name}(${count})`)
      .join(", ");

    const summary = [
      `Agent activity: ${records.length} tool calls (${successful} ok, ${failed} failed)`,
      `Files modified: ${filesModified.size}`,
      `Top tools: ${topTools || "none"}`,
    ].join(". ");

    return {
      totalCalls: records.length,
      successfulCalls: successful,
      failedCalls: failed,
      filesModified: Array.from(filesModified),
      toolsUsed,
      summary,
    };
  }

  // ── Internal ─────────────────────────────────────────────────────────────

  private isReadOnlyTool(name: string): boolean {
    const readOnlyTools = [
      "read_file",
      "list_dir",
      "glob",
      "grep",
      "memory_search",
      "knowledge_search",
      "data_list",
      "data_load",
    ];
    return readOnlyTools.includes(name);
  }

  private extractChangedFiles(
    toolName: string,
    args: Record<string, unknown>,
    result: ToolResult,
  ): string[] {
    const files: string[] = [];

    // write_file / edit_file → file_path
    if (args.file_path && typeof args.file_path === "string") {
      files.push(args.file_path);
    }

    // bash → try to extract from metadata or args
    if (toolName === "bash" && typeof args.command === "string") {
      // Simple heuristic: look for file paths in common commands
      const cmd = args.command;
      if (cmd.includes(">>") || cmd.includes(">")) {
        const match = cmd.match(/[>]{1,2}\s*(\S+)/);
        if (match) files.push(match[1]);
      }
    }

    return [...new Set(files)];
  }

  private generateSummary(
    toolName: string,
    args: Record<string, unknown>,
    result: ToolResult,
  ): string {
    if (!result.ok) {
      return `${toolName} failed: ${result.error?.message ?? "unknown error"}`;
    }

    switch (toolName) {
      case "write_file":
        return `Wrote ${args.file_path}`;
      case "edit_file":
        return `Edited ${args.file_path}`;
      case "read_file":
        return `Read ${args.file_path}`;
      case "bash":
        return `Executed: ${this.truncate(String(args.command ?? ""), 100)}`;
      case "memory_write":
        return `Saved memory: ${this.truncate(String(args.content ?? ""), 80)}`;
      default:
        return `${toolName} completed`;
    }
  }

  private truncate(text: string, maxLen: number): string {
    if (text.length <= maxLen) return text;
    return text.slice(0, maxLen) + "...";
  }
}
