/**
 * Session JSONL write API (delegates to backend when configured).
 */
import type { StopReason, Usage } from "../types/index.js";
import type {
  AssistantEntry,
  BranchEntry,
  CustomTitleEntry,
  ToolCallEntry,
  ToolResultEntry,
  UserEntry,
} from "./types.js";
import { getSessionBackend } from "./session-backend.js";
import { appendSessionEntry, sessionTimestamp } from "./session-store-append.js";
import type { SessionStoreContext } from "./session-store-context.js";
import { preview } from "./jsonl-session-io.js";

function append(ctx: SessionStoreContext, entry: Parameters<typeof appendSessionEntry>[1]): void {
  appendSessionEntry(ctx.filePath, entry);
}

function now(): string {
  return sessionTimestamp();
}

export function writeSessionStart(
  ctx: SessionStoreContext,
  model: string,
  provider: string
): void {
  const backend = getSessionBackend();
  if (backend) {
    backend.writeStart(ctx.sessionId, ctx.cwd, model, provider);
    return;
  }
  append(ctx, {
    type: "session_start",
    sessionId: ctx.sessionId,
    timestamp: now(),
    cwd: ctx.cwd,
    model,
    provider,
  });
}

export function writeSessionTitle(ctx: SessionStoreContext, title: string): void {
  const backend = getSessionBackend();
  if (backend) {
    backend.writeTitle(ctx.sessionId, ctx.cwd, title);
    return;
  }
  const entry: CustomTitleEntry = {
    type: "custom-title",
    sessionId: ctx.sessionId,
    timestamp: now(),
    customTitle: title,
  };
  append(ctx, entry);
}

export function writeSessionAiTitle(ctx: SessionStoreContext, aiTitle: string): void {
  const backend = getSessionBackend();
  if (backend) {
    backend.writeAiTitle(ctx.sessionId, ctx.cwd, aiTitle);
    return;
  }
  append(ctx, {
    type: "ai-title",
    sessionId: ctx.sessionId,
    timestamp: now(),
    aiTitle,
  });
}

export function writeSessionSummary(ctx: SessionStoreContext, summary: string): void {
  const backend = getSessionBackend();
  if (backend) {
    backend.writeSummary(ctx.sessionId, ctx.cwd, summary);
    return;
  }
  append(ctx, {
    type: "summary",
    sessionId: ctx.sessionId,
    timestamp: now(),
    summary,
  });
}

export function writeSessionTag(ctx: SessionStoreContext, tag: string): void {
  const backend = getSessionBackend();
  if (backend) {
    backend.writeTag(ctx.sessionId, ctx.cwd, tag);
    return;
  }
  append(ctx, {
    type: "tag",
    sessionId: ctx.sessionId,
    timestamp: now(),
    tag,
  });
}

export function writeSessionGitBranch(ctx: SessionStoreContext, gitBranch: string): void {
  const backend = getSessionBackend();
  if (backend) {
    backend.writeGitBranch(ctx.sessionId, ctx.cwd, gitBranch);
    return;
  }
  append(ctx, {
    type: "git-branch",
    sessionId: ctx.sessionId,
    timestamp: now(),
    gitBranch,
  });
}

export function writeSessionPrLink(
  ctx: SessionStoreContext,
  p: { prUrl: string; prRepository?: string; prNumber?: number }
): void {
  const backend = getSessionBackend();
  if (backend) {
    backend.writePrLink(ctx.sessionId, ctx.cwd, p);
    return;
  }
  append(ctx, {
    type: "pr-link",
    sessionId: ctx.sessionId,
    timestamp: now(),
    prUrl: p.prUrl,
    ...(p.prRepository ? { prRepository: p.prRepository } : {}),
    ...(p.prNumber ? { prNumber: p.prNumber } : {}),
  });
}

export function writeSessionBranch(
  ctx: SessionStoreContext,
  p: {
    parentSessionId: string;
    forkedFromUuid?: string;
    title?: string;
    status?: BranchEntry["status"];
    worktreePath?: string;
    worktreeBranch?: string;
    baseCommit?: string;
  }
): void {
  const backend = getSessionBackend();
  if (backend) {
    backend.writeBranch(ctx.sessionId, ctx.cwd, p);
    return;
  }
  const entry: BranchEntry = {
    type: "branch",
    sessionId: ctx.sessionId,
    timestamp: now(),
    parentSessionId: p.parentSessionId,
    ...(p.forkedFromUuid ? { forkedFromUuid: p.forkedFromUuid } : {}),
    ...(p.title ? { title: p.title } : {}),
    status: p.status ?? "active",
    ...(p.worktreePath ? { worktreePath: p.worktreePath } : {}),
    ...(p.worktreeBranch ? { worktreeBranch: p.worktreeBranch } : {}),
    ...(p.baseCommit ? { baseCommit: p.baseCommit } : {}),
  };
  append(ctx, entry);
}

export function writeSessionUser(ctx: SessionStoreContext, content: string): string {
  const backend = getSessionBackend();
  if (backend) {
    return backend.writeUser(ctx.sessionId, ctx.cwd, content);
  }
  const uuid = crypto.randomUUID();
  const entry: UserEntry = {
    type: "user",
    sessionId: ctx.sessionId,
    timestamp: now(),
    uuid,
    content,
  };
  append(ctx, entry);
  return uuid;
}

export function writeSessionAssistant(
  ctx: SessionStoreContext,
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
  }
): string {
  const backend = getSessionBackend();
  if (backend) {
    return backend.writeAssistant(ctx.sessionId, ctx.cwd, p);
  }
  const uuid = crypto.randomUUID();
  const entry: AssistantEntry = {
    type: "assistant",
    sessionId: ctx.sessionId,
    timestamp: now(),
    uuid,
    parentUuid: p.parentUuid,
    content: p.content,
    model: p.model,
    provider: p.provider,
    stopReason: p.stopReason,
    usage: p.usage,
    turn: p.turn,
    latencyMs: p.latencyMs,
    toolCalls: p.toolCalls,
    status: p.status,
  };
  append(ctx, entry);
  return uuid;
}

export function writeSessionToolCall(
  ctx: SessionStoreContext,
  p: {
    parentUuid: string;
    toolName: string;
    toolCallId: string;
    arguments: Record<string, unknown>;
  }
): string {
  const backend = getSessionBackend();
  if (backend) {
    return backend.writeToolCall(ctx.sessionId, ctx.cwd, p);
  }
  const uuid = crypto.randomUUID();
  const entry: ToolCallEntry = {
    type: "tool_call",
    sessionId: ctx.sessionId,
    timestamp: now(),
    uuid,
    parentUuid: p.parentUuid,
    toolName: p.toolName,
    toolCallId: p.toolCallId,
    arguments: p.arguments,
  };
  append(ctx, entry);
  return uuid;
}

export function writeSessionToolResult(
  ctx: SessionStoreContext,
  p: { parentUuid: string; toolCallId: string; content: string }
): void {
  const backend = getSessionBackend();
  if (backend) {
    backend.writeToolResult(ctx.sessionId, ctx.cwd, p);
    return;
  }
  const entry: ToolResultEntry = {
    type: "tool_result",
    sessionId: ctx.sessionId,
    timestamp: now(),
    uuid: crypto.randomUUID(),
    parentUuid: p.parentUuid,
    toolCallId: p.toolCallId,
    content: p.content,
  };
  append(ctx, entry);
}

export function writeSessionEnd(
  ctx: SessionStoreContext,
  totalUsage: Usage,
  totalCostUsd: number,
  turnCount: number,
  lastPrompt?: string
): void {
  const backend = getSessionBackend();
  if (backend) {
    backend.writeEnd(ctx.sessionId, ctx.cwd, totalUsage, totalCostUsd, turnCount, lastPrompt);
    return;
  }
  const normalizedLastPrompt = preview(lastPrompt);
  if (normalizedLastPrompt) {
    append(ctx, {
      type: "last-prompt",
      sessionId: ctx.sessionId,
      timestamp: now(),
      lastPrompt: normalizedLastPrompt,
    });
  }
  append(ctx, {
    type: "session_end",
    sessionId: ctx.sessionId,
    timestamp: now(),
    totalUsage,
    totalCostUsd,
    turnCount,
  });
}
