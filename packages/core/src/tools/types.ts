// Tool Runtime 核心类型

import type { StructuredPatchHunk } from "diff";
import type { Tool } from "../types/tool.js";

export type { Tool };

// ── RenderHint ────────────────────────────────────────────────────────────────

export type RenderHint =
  | { type: "text" }
  | { type: "code"; lang?: string }
  | { type: "diff" }
  | { type: "file-list" }
  | { type: "image"; mimeType: string }
  | { type: "error" }
  | { type: "bash-output"; exitCode: number };

// ── ToolResult ────────────────────────────────────────────────────────────────

export type ToolErrorCode =
  | "PERMISSION_DENIED"
  | "PATH_OUTSIDE_CWD"
  | "BUDGET_EXCEEDED"
  | "TIMEOUT"
  | "NOT_FOUND"
  | "EXEC_ERROR"
  | "UNKNOWN";

export interface ToolResult {
  ok: boolean;
  content: string;
  metadata?: {
    bytesRead?: number;
    linesRead?: number;
    linesChanged?: number;
    exitCode?: number;
    truncated?: boolean;
    renderHint?: RenderHint;
    /** Structured diff hunks for file-modifying tools — used by DiffView in the REPL. */
    diff?: { filePath: string; hunks: StructuredPatchHunk[] };
  };
  error?: {
    code: ToolErrorCode;
    message: string;
    retryable: boolean;
  };
  /** Number of automatic retries performed before this result was produced. */
  retryCount?: number;
  /**
   * When present, the tool execution was blocked and is awaiting user confirmation.
   * The REPL layer should prompt the user, then call allowPath() on the SecurityPlugin
   * and retry the tool call if the user approves.
   */
  needsConfirm?: {
    /** Human-readable prompt shown to the user. */
    message: string;
    /** The directory to whitelist on approval (passed to SecurityPlugin.allowPath). */
    allowDir: string;
    /** Original tool name + args, so the caller can retry identically. */
    retry: { name: string; args: Record<string, unknown> };
  };
  /** Present when the execution was a dry-run simulation. */
  dryRun?: boolean;
}

// ── ToolContext ───────────────────────────────────────────────────────────────

export interface ToolContext {
  cwd: string;
  sessionId: string;
  /** Directories explicitly approved by the user for this session. */
  allowedPaths?: string[];
  env?: Record<string, string>;
  signal?: AbortSignal;
  dryRun?: boolean;
  /** Optional memory store for memory_write / memory_search tools. */
  memoryStore?: import("../memory/store.js").MemoryStore;
  /** Optional user data store for data_save / data_load / data_list / data_delete tools. */
  userDataStore?: import("../storage/user-data.js").UserDataStore;
}

// ── ToolVersion ─────────────────────────────────────────────────────────────

export interface ToolVersion {
  version: string;
  deprecated?: boolean;
  deprecatedReason?: string;
  replacedBy?: string;
}

// ── ToolMiddleware ──────────────────────────────────────────────────────────

export interface ToolMiddleware {
  name: string;
  /** Before: can modify args or short-circuit with a result. */
  before?: (
    name: string,
    args: Record<string, unknown>,
    ctx: ToolContext
  ) => Promise<{ args: Record<string, unknown>; skip?: boolean; result?: ToolResult } | null>;
  /** After: can transform the result. */
  after?: (
    name: string,
    args: Record<string, unknown>,
    result: ToolResult,
    ctx: ToolContext
  ) => Promise<ToolResult>;
  /** On error: can recover (return ToolResult) or re-throw (return null). */
  onError?: (
    name: string,
    args: Record<string, unknown>,
    error: Error,
    ctx: ToolContext
  ) => Promise<ToolResult | null>;
}

// ── ToolGroup ───────────────────────────────────────────────────────────────

export interface ToolGroup {
  name: string;
  description?: string;
  defaults?: Partial<ToolDef["options"]>;
  version?: string;
  tags?: string[];
}

// ── ToolExecutionStats ──────────────────────────────────────────────────────

export interface ToolCallRecord {
  toolName: string;
  args: Record<string, unknown>;
  result: ToolResult;
  durationMs: number;
  timestamp: number;
  sessionId: string;
}

export interface ToolStats {
  totalCalls: number;
  successCount: number;
  errorCount: number;
  avgDurationMs: number;
  p50DurationMs: number;
  p95DurationMs: number;
  p99DurationMs: number;
  errorRate: number;
  lastCalledAt: number | null;
}

// ── ToolDef ───────────────────────────────────────────────────────────────────

export type JSONSchema = Record<string, unknown>;

export interface ToolDef<TArgs = object> {
  name: string;
  description: string;
  parameters: JSONSchema;

  options?: {
    timeoutMs?: number;
    retries?: number;
    idempotent?: boolean;
    riskLevel?: "low" | "medium" | "high";
  };

  /** Version info for this tool. */
  version?: ToolVersion;
  /** Tool group this tool belongs to. */
  group?: string;

  execute(args: TArgs, ctx: ToolContext): Promise<ToolResult>;
}

// ── ToolLifecycleHook ─────────────────────────────────────────────────────────

export interface ToolLifecycleHook {
  onBeforeToolCall?(
    name: string,
    args: Record<string, unknown>,
    ctx: ToolContext
  ): Promise<ToolResult | null>;

  onAfterToolCall?(
    name: string,
    args: Record<string, unknown>,
    result: ToolResult,
    ctx: ToolContext
  ): Promise<void>;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

export function toolDefToSchema<TArgs = Record<string, unknown>>(def: ToolDef<TArgs>): Tool {
  return {
    name: def.name,
    description: def.description,
    parameters: def.parameters as Tool["parameters"],
  };
}

export function errorResult(
  code: ToolErrorCode,
  message: string,
  retryable = false
): ToolResult {
  return {
    ok: false,
    content: message,
    error: { code, message, retryable },
  };
}
