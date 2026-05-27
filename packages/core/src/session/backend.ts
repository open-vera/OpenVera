/**
 * SessionStoreBackend — unified interface for session persistence.
 *
 * Both the JSONL file-based backend and the SQLite backend implement this
 * interface. SessionStore delegates to whichever backend is configured.
 */

import type { StopReason, Usage } from "../types/index.js";
import type { Message } from "../types/message.js";
import type {
  BranchEntry,
  ForkedSession,
  ForkSessionOptions,
  ListSessionsOptions,
  ListSessionsResult,
  LoadedSession,
  SessionSummary,
  SessionTranscriptPreview,
} from "./types.js";

// ── Backend interface ───────────────────────────────────────────────────────

export interface SessionStoreBackend {
  readonly name: string;

  /** Write a session_start entry. */
  writeStart(sessionId: string, cwd: string, model: string, provider: string): void;

  /** Write a custom-title entry. */
  writeTitle(sessionId: string, cwd: string, title: string): void;

  /** Write an ai-title entry. */
  writeAiTitle(sessionId: string, cwd: string, aiTitle: string): void;

  /** Write a summary entry. */
  writeSummary(sessionId: string, cwd: string, summary: string): void;

  /** Write a tag entry. */
  writeTag(sessionId: string, cwd: string, tag: string): void;

  /** Write a git-branch entry. */
  writeGitBranch(sessionId: string, cwd: string, gitBranch: string): void;

  /** Write a pr-link entry. */
  writePrLink(
    sessionId: string,
    cwd: string,
    p: { prUrl: string; prRepository?: string; prNumber?: number },
  ): void;

  /** Write a branch entry. */
  writeBranch(
    sessionId: string,
    cwd: string,
    p: {
      parentSessionId: string;
      forkedFromUuid?: string;
      title?: string;
      status?: BranchEntry["status"];
      worktreePath?: string;
      worktreeBranch?: string;
      baseCommit?: string;
    },
  ): void;

  /** Write a user message entry. Returns the UUID. */
  writeUser(sessionId: string, cwd: string, content: string): string;

  /** Write an assistant response entry. Returns the UUID. */
  writeAssistant(
    sessionId: string,
    cwd: string,
    p: {
      parentUuid: string;
      content: string;
      model: string;
      provider: string;
      stopReason: StopReason;
      usage: Usage;
      turn: number;
      latencyMs: number;
      toolCalls: string[];
      status: "ok" | "error";
    },
  ): string;

  /** Write a tool_call entry. Returns the UUID. */
  writeToolCall(
    sessionId: string,
    cwd: string,
    p: {
      parentUuid: string;
      toolName: string;
      toolCallId: string;
      arguments: Record<string, unknown>;
    },
  ): string;

  /** Write a tool_result entry. */
  writeToolResult(
    sessionId: string,
    cwd: string,
    p: {
      parentUuid: string;
      toolCallId: string;
      content: string;
    },
  ): void;

  /** Write session_end entry (with optional last-prompt). */
  writeEnd(
    sessionId: string,
    cwd: string,
    totalUsage: Usage,
    totalCostUsd: number,
    turnCount: number,
    lastPrompt?: string,
  ): void;

  // ── Query operations ─────────────────────────────────────────────────────

  /** List sessions with optional filtering and pagination. */
  listSessions(opts?: ListSessionsOptions): ListSessionsResult;

  /** Load a session for resume. */
  loadSession(sessionId: string, cwd?: string): LoadedSession;

  /** Load a transcript preview with tool uses. */
  loadTranscriptPreview(sessionId: string, cwd?: string): SessionTranscriptPreview;

  // ── Branch operations ────────────────────────────────────────────────────

  /** Fork a session into a new branch. */
  forkSession(options: ForkSessionOptions): ForkedSession;

  /** List branches of a parent session. */
  listBranches(parentSessionId: string, cwd?: string): SessionSummary[];

  /** Discard a branch. */
  discardBranch(sessionId: string, cwd?: string): void;

  /** Adopt a branch. */
  adoptBranch(sessionId: string, cwd?: string): void;

  /** Mark a branch as merged. */
  markBranchMerged(sessionId: string, cwd?: string): void;
}

// ── Backend options ─────────────────────────────────────────────────────────

export interface BackendOptions {
  /** Backend type: "jsonl" (default) or "sqlite" */
  backend?: "jsonl" | "sqlite";
  /** Database path for SQLite backend */
  dbPath?: string;
  /** Whether to enable FTS5 for SQLite */
  enableFts?: boolean;
  /** Whether to auto-migrate JSONL files to SQLite on init */
  autoMigrate?: boolean;
}
