// Session 持久化 — JSONL entry 类型定义

import type { StopReason, Usage } from "../types/index.js";
import type { Message } from "../types/message.js";

// ── Base ──────────────────────────────────────────────────────────────────────

interface BaseEntry {
  sessionId: string;
  timestamp: string; // ISO-8601
}

// ── Entry types ───────────────────────────────────────────────────────────────

export interface SessionStartEntry extends BaseEntry {
  type: "session_start";
  cwd: string;
  model: string;
  provider: string;
}

export interface UserEntry extends BaseEntry {
  type: "user";
  uuid: string;
  content: string;
}

export interface AssistantEntry extends BaseEntry {
  type: "assistant";
  uuid: string;
  parentUuid: string;
  content: string;
  model: string;
  provider: string;
  stopReason: StopReason;
  usage: Usage;
  turn: number;
  latencyMs: number;
  toolCalls: string[];   // tool names used in this turn
  status: "ok" | "error";
}

export interface ToolCallEntry extends BaseEntry {
  type: "tool_call";
  uuid: string;
  parentUuid: string;
  toolName: string;
  toolCallId: string;
  arguments: Record<string, unknown>;
}

export interface ToolResultEntry extends BaseEntry {
  type: "tool_result";
  uuid: string;
  parentUuid: string; // uuid of the tool_call entry
  toolCallId: string;
  content: string;
}

export interface SessionEndEntry extends BaseEntry {
  type: "session_end";
  totalUsage: Usage;
  totalCostUsd: number;
  turnCount: number;
}

export interface LastPromptEntry extends BaseEntry {
  type: "last-prompt" | "last_prompt";
  lastPrompt: string;
}

export interface CustomTitleEntry extends BaseEntry {
  type: "custom-title" | "custom_title";
  title?: string;
  customTitle?: string;
}

export interface AiTitleEntry extends BaseEntry {
  type: "ai-title";
  aiTitle: string;
}

export interface SummaryEntry extends BaseEntry {
  type: "summary";
  summary: string;
  leafUuid?: string;
}

export interface TagEntry extends BaseEntry {
  type: "tag";
  tag: string;
}

export interface GitBranchEntry extends BaseEntry {
  type: "git-branch";
  gitBranch: string;
}

export interface PrLinkEntry extends BaseEntry {
  type: "pr-link";
  prUrl: string;
  prRepository?: string;
  prNumber?: number;
}

export type BranchStatus = "active" | "adopted" | "merged" | "discarded";

export interface BranchEntry extends BaseEntry {
  type: "branch";
  parentSessionId: string;
  forkedFromUuid?: string;
  title?: string;
  status: BranchStatus;
  worktreePath?: string;
  worktreeBranch?: string;
  baseCommit?: string;
}

export type SessionEntry =
  | SessionStartEntry
  | UserEntry
  | AssistantEntry
  | ToolCallEntry
  | ToolResultEntry
  | SessionEndEntry
  | LastPromptEntry
  | CustomTitleEntry
  | AiTitleEntry
  | SummaryEntry
  | TagEntry
  | GitBranchEntry
  | PrLinkEntry
  | BranchEntry;

// ── Query / resume types ──────────────────────────────────────────────────────

export interface SessionSummary {
  sessionId: string;
  filePath: string;
  startedAt: Date;
  lastActivityAt: Date;
  model: string;
  provider: string;
  turnCount: number;
  messageCount?: number;
  totalUsage: Usage;
  totalCostUsd: number;
  cwd: string;
  fileSize?: number;
  createdAt?: Date;
  title?: string;
  summary?: string;
  firstPrompt?: string;
  lastUserInput?: string;
  tag?: string;
  gitBranch?: string;
  pr?: {
    url: string;
    repository?: string;
    number?: number;
  };
  branch?: {
    parentSessionId: string;
    forkedFromUuid?: string;
    title?: string;
    status: BranchStatus;
    worktreePath?: string;
    worktreeBranch?: string;
    baseCommit?: string;
  };
}

export interface LoadedSession {
  sessionId: string;
  filePath: string;
  cwd: string;
  history: Message[];
  totalUsage: Usage;
  totalCostUsd: number;
  turnCount: number;
  model: string;
  provider: string;
}

export interface SessionCandidate {
  sessionId: string;
  filePath: string;
  mtimeMs: number;
  fileSize: number;
  projectPath?: string;
}

export interface ListSessionsOptions {
  cwd?: string;
  all?: boolean;
  limit?: number;
  offset?: number;
  includeWorktrees?: boolean;
}

export interface ListSessionsResult {
  sessions: SessionSummary[];
  nextOffset?: number;
  totalCandidates: number;
}

export interface SessionPreviewToolUse {
  name: string;
  args: Record<string, unknown>;
  result: {
    ok: boolean;
    content: string;
  };
}

export interface SessionPreviewMessage {
  role: "user" | "assistant";
  content: string;
  toolUses?: SessionPreviewToolUse[];
}

export interface SessionTranscriptPreview {
  sessionId: string;
  messages: SessionPreviewMessage[];
  summary?: SessionSummary;
}

export interface ForkSessionOptions {
  fromSessionId: string;
  cwd?: string;
  title?: string;
  atUuid?: string;
  worktreePath?: string;
  worktreeBranch?: string;
  baseCommit?: string;
}

export interface ForkedSession {
  sessionId: string;
  parentSessionId: string;
  forkedFromUuid?: string;
  filePath: string;
  title?: string;
  worktreePath?: string;
  worktreeBranch?: string;
  baseCommit?: string;
}

// ── Accumulated cost (in-memory, held by App.tsx) ─────────────────────────────

export interface ModelCostRecord {
  usage: Usage;
  costUsd: number;
}

export interface AccumulatedCost {
  totalUsd: number;
  byModel: Record<string, ModelCostRecord>;
  totalUsage: Usage;
}
