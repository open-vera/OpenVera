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

export interface CustomTitleEntry extends BaseEntry {
  type: "custom_title";
  title: string;
}

export type SessionEntry =
  | SessionStartEntry
  | UserEntry
  | AssistantEntry
  | ToolCallEntry
  | ToolResultEntry
  | SessionEndEntry
  | CustomTitleEntry;

// ── Query / resume types ──────────────────────────────────────────────────────

export interface SessionSummary {
  sessionId: string;
  filePath: string;
  startedAt: Date;
  lastActivityAt: Date;
  model: string;
  provider: string;
  turnCount: number;
  totalCostUsd: number;
  cwd: string;
  title?: string;
}

export interface LoadedSession {
  sessionId: string;
  history: Message[];
  totalUsage: Usage;
  totalCostUsd: number;
  turnCount: number;
  model: string;
  provider: string;
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
