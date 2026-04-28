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
}

// ── ToolDef ───────────────────────────────────────────────────────────────────

export type JSONSchema = Record<string, unknown>;

export interface ToolDef<TArgs = Record<string, unknown>> {
  // Schema exposed to the model
  name: string;
  description: string;
  parameters: JSONSchema;

  options?: {
    timeoutMs?: number;
    retries?: number;
    idempotent?: boolean;
    riskLevel?: "low" | "medium" | "high";
  };

  execute(args: TArgs, ctx: ToolContext): Promise<ToolResult>;
}

// ── ToolLifecycleHook ─────────────────────────────────────────────────────────
// Tier 3 hook: per-tool interception for ToolRegistry plugins (SecurityPlugin,
// AnalyticsPlugin). Turn/session lifecycle belongs in AgentHooks (agent/loop.ts).

export interface ToolLifecycleHook {
  /** Return non-null to short-circuit execution (harness denial). */
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

export function toolDefToSchema(def: ToolDef): Tool {
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
