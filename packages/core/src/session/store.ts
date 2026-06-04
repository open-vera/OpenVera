// Session 存储 — JSONL 读写 + 列表 + 恢复 + SQLite 后端支持

import { mkdirSync } from "node:fs";
import type { StopReason, Usage } from "../types/index.js";
import type { SessionStoreBackend } from "./backend.js";
import type {
  BranchEntry,
  ForkedSession,
  ForkSessionOptions,
  ListSessionsOptions,
  ListSessionsResult,
  LoadedSession,
  SessionCandidate,
  SessionSummary,
  SessionTranscriptPreview,
} from "./types.js";
import {
  configureSqliteSessionBackend,
  getSessionBackend,
  setSessionBackend,
} from "./session-backend.js";
import type { SessionStoreContext } from "./session-store-context.js";
import {
  adoptBranch as adoptBranchOp,
  discardBranch as discardBranchOp,
  forkSession as forkSessionOp,
  listBranches as listBranchesOp,
  markBranchMerged as markBranchMergedOp,
} from "./session-store-branch.js";
import { loadSession as loadSessionOp, loadTranscriptPreview as loadTranscriptPreviewOp } from "./session-store-load.js";
import {
  listSessionCandidates as listSessionCandidatesOp,
  listSessions as listSessionsOp,
  listSessionsPaged as listSessionsPagedOp,
} from "./session-store-list.js";
import {
  writeSessionAiTitle,
  writeSessionAssistant,
  writeSessionBranch,
  writeSessionEnd,
  writeSessionGitBranch,
  writeSessionPrLink,
  writeSessionStart,
  writeSessionSummary,
  writeSessionTag,
  writeSessionTitle,
  writeSessionToolCall,
  writeSessionToolResult,
  writeSessionUser,
} from "./session-store-writes.js";
import { projectDir, sessionFilePath } from "./store-paths.js";

// ── SessionStore ──────────────────────────────────────────────────────────────

export class SessionStore {
  readonly sessionId: string;
  readonly filePath: string;
  private readonly _cwd: string;

  static configure(backend: SessionStoreBackend | null): void {
    setSessionBackend(backend);
  }

  static getBackend(): SessionStoreBackend | null {
    return getSessionBackend();
  }

  static async configureSqlite(options: {
    dbPath: string;
    enableFts?: boolean;
    autoMigrate?: boolean;
    sessionsDir?: string;
  }): Promise<{ backend: import("./sqlite-backend.js").SQLiteSessionBackend; migrated: number }> {
    return configureSqliteSessionBackend(options);
  }

  constructor(opts: { sessionId?: string; cwd?: string } = {}) {
    this._cwd = opts.cwd ?? process.cwd();
    this.sessionId = opts.sessionId ?? crypto.randomUUID();
    const dir = projectDir(this._cwd);
    mkdirSync(dir, { recursive: true });
    this.filePath = sessionFilePath(this.sessionId, this._cwd);
  }

  get cwd(): string {
    return this._cwd;
  }

  /** Identity bundle for JSONL write helpers. */
  context(): SessionStoreContext {
    return { sessionId: this.sessionId, filePath: this.filePath, cwd: this._cwd };
  }

  private static createHandle(opts: { sessionId?: string; cwd?: string } = {}): SessionStore {
    return new SessionStore(opts);
  }

  // ── Write API ───────────────────────────────────────────────────────────────

  writeStart(model: string, provider: string): void {
    writeSessionStart(this.context(), model, provider);
  }

  writeTitle(title: string): void {
    writeSessionTitle(this.context(), title);
  }

  writeAiTitle(aiTitle: string): void {
    writeSessionAiTitle(this.context(), aiTitle);
  }

  writeSummary(summary: string): void {
    writeSessionSummary(this.context(), summary);
  }

  writeTag(tag: string): void {
    writeSessionTag(this.context(), tag);
  }

  writeGitBranch(gitBranch: string): void {
    writeSessionGitBranch(this.context(), gitBranch);
  }

  writePrLink(p: { prUrl: string; prRepository?: string; prNumber?: number }): void {
    writeSessionPrLink(this.context(), p);
  }

  writeBranch(p: {
    parentSessionId: string;
    forkedFromUuid?: string;
    title?: string;
    status?: BranchEntry["status"];
    worktreePath?: string;
    worktreeBranch?: string;
    baseCommit?: string;
  }): void {
    writeSessionBranch(this.context(), p);
  }

  writeUser(content: string): string {
    return writeSessionUser(this.context(), content);
  }

  writeAssistant(p: {
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
  }): string {
    return writeSessionAssistant(this.context(), p);
  }

  writeToolCall(p: {
    parentUuid: string;
    toolName: string;
    toolCallId: string;
    arguments: Record<string, unknown>;
  }): string {
    return writeSessionToolCall(this.context(), p);
  }

  writeToolResult(p: { parentUuid: string; toolCallId: string; content: string }): void {
    writeSessionToolResult(this.context(), p);
  }

  writeEnd(totalUsage: Usage, totalCostUsd: number, turnCount: number, lastPrompt?: string): void {
    writeSessionEnd(this.context(), totalUsage, totalCostUsd, turnCount, lastPrompt);
  }

  // ── Static: list / branch / load ────────────────────────────────────────────

  static listSessions(cwd?: string): SessionSummary[] {
    return listSessionsOp(cwd);
  }

  static listSessionCandidates(opts: ListSessionsOptions = {}): SessionCandidate[] {
    return listSessionCandidatesOp(opts);
  }

  static listSessionsPaged(opts: ListSessionsOptions = {}): ListSessionsResult {
    return listSessionsPagedOp(opts);
  }

  static forkSession(options: ForkSessionOptions): ForkedSession {
    return forkSessionOp(options, SessionStore.createHandle);
  }

  static listBranches(parentSessionId: string, cwd?: string): SessionSummary[] {
    return listBranchesOp(parentSessionId, cwd);
  }

  static discardBranch(sessionId: string, cwd?: string): void {
    discardBranchOp(sessionId, cwd, SessionStore.createHandle);
  }

  static adoptBranch(sessionId: string, cwd?: string): void {
    adoptBranchOp(sessionId, cwd, SessionStore.createHandle);
  }

  static markBranchMerged(sessionId: string, cwd?: string): void {
    markBranchMergedOp(sessionId, cwd, SessionStore.createHandle);
  }

  static loadSession(sessionId: string, cwd?: string): LoadedSession {
    return loadSessionOp(sessionId, cwd);
  }

  static loadTranscriptPreview(sessionId: string, cwd?: string): SessionTranscriptPreview {
    return loadTranscriptPreviewOp(sessionId, cwd);
  }
}
