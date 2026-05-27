/**
 * SQLite-backed session storage adapter.
 *
 * Replaces the JSONL-file-based SessionStore with a SqliteStorageProvider
 * while preserving the same JSONL content format inside the database.
 * Provides migration from existing JSONL files and query/filter capabilities.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { SqliteStorageProvider } from "./sqlite.js";
import type {
  StoredSession,
  SessionMetadata,
  StorageQuery,
  StorageValue,
} from "./types.js";
import type { Usage } from "../types/index.js";
import type { Message } from "../types/message.js";
import { SessionNotFoundError } from "../errors.js";
import { calculateCost } from "../session/cost.js";
import type {
  SessionEntry,
  SessionSummary,
  LoadedSession,
  BranchEntry,
  ListSessionsOptions,
  ListSessionsResult,
  ForkSessionOptions,
  ForkedSession,
} from "../session/types.js";

// ── Constants ───────────────────────────────────────────────────────────────

const NAMESPACE = "sessions";

// ── Query / Filter types ────────────────────────────────────────────────────

export interface SessionFilter {
  model?: string;
  provider?: string;
  cwd?: string;
  tags?: string[];
  createdAfter?: string;
  createdBefore?: string;
  limit?: number;
  offset?: number;
  orderBy?: "createdAt" | "updatedAt";
  order?: "asc" | "desc";
  fullTextSearch?: string;
}

export interface MigrationVerificationResult {
  ok: boolean;
  sessionId: string;
  sourceEntries: number;
  migratedEntries: number;
  contentMatch?: boolean;
  sourceCorruptLines?: number;
  migratedCorruptLines?: number;
  reason?: string;
}

// ── SessionStorageAdapter ───────────────────────────────────────────────────

export class SessionStorageAdapter {
  private storage: SqliteStorageProvider;

  constructor(storage: SqliteStorageProvider) {
    this.storage = storage;
  }

  async initialize(): Promise<void> {
    await this.storage.initialize();
  }

  async close(): Promise<void> {
    await this.storage.close();
  }

  isHealthy(): boolean {
    return this.storage.isHealthy();
  }

  // ── Write operations ──────────────────────────────────────────────────────

  /**
   * Create a new session with an initial session_start entry.
   */
  async createSession(
    sessionId: string,
    model: string,
    provider: string,
    cwd: string,
  ): Promise<void> {
    const now = new Date().toISOString();
    const startEntry: SessionEntry = {
      type: "session_start",
      sessionId,
      timestamp: now,
      cwd,
      model,
      provider,
    } as SessionEntry;

    const stored: StoredSession = {
      sessionId,
      content: JSON.stringify(startEntry) + "\n",
      createdAt: now,
      updatedAt: now,
      metadata: { model, provider, cwd },
    };

    await this.storage.set(
      NAMESPACE,
      sessionId,
      stored as unknown as StorageValue,
    );
  }

  /**
   * Append a pre-built SessionEntry to an existing session.
   */
  async appendEntry(sessionId: string, entry: SessionEntry): Promise<void> {
    const stored = await this.getStoredSession(sessionId);
    if (!stored) throw new SessionNotFoundError(sessionId);

    stored.content += JSON.stringify(entry) + "\n";
    stored.updatedAt = new Date().toISOString();
    this.updateMetadata(stored, entry);

    await this.storage.set(
      NAMESPACE,
      sessionId,
      stored as unknown as StorageValue,
    );
  }

  /**
   * Write a user message entry.
   */
  async writeUser(sessionId: string, content: string): Promise<string> {
    const uuid = crypto.randomUUID();
    const entry: SessionEntry = {
      type: "user",
      sessionId,
      timestamp: new Date().toISOString(),
      uuid,
      content,
    } as SessionEntry;
    await this.appendEntry(sessionId, entry);
    return uuid;
  }

  /**
   * Write an assistant response entry.
   */
  async writeAssistant(
    sessionId: string,
    params: {
      parentUuid: string;
      content: string;
      model: string;
      provider: string;
      stopReason: "end_turn" | "tool_use" | "max_tokens" | "stop";
      usage: Usage;
      turn: number;
      latencyMs: number;
      toolCalls: string[];
      status: "ok" | "error";
    },
  ): Promise<string> {
    const uuid = crypto.randomUUID();
    const entry: SessionEntry = {
      type: "assistant",
      sessionId,
      timestamp: new Date().toISOString(),
      uuid,
      ...params,
    } as SessionEntry;
    await this.appendEntry(sessionId, entry);
    return uuid;
  }

  /**
   * Write a tool call entry.
   */
  async writeToolCall(
    sessionId: string,
    params: {
      parentUuid: string;
      toolName: string;
      toolCallId: string;
      arguments: Record<string, unknown>;
    },
  ): Promise<string> {
    const uuid = crypto.randomUUID();
    const entry: SessionEntry = {
      type: "tool_call",
      sessionId,
      timestamp: new Date().toISOString(),
      uuid,
      ...params,
    } as SessionEntry;
    await this.appendEntry(sessionId, entry);
    return uuid;
  }

  /**
   * Write a tool result entry.
   */
  async writeToolResult(
    sessionId: string,
    params: {
      parentUuid: string;
      toolCallId: string;
      content: string;
    },
  ): Promise<void> {
    const entry: SessionEntry = {
      type: "tool_result",
      sessionId,
      timestamp: new Date().toISOString(),
      uuid: crypto.randomUUID(),
      ...params,
    } as SessionEntry;
    await this.appendEntry(sessionId, entry);
  }

  /**
   * Write session end entry with final stats.
   */
  async writeEnd(
    sessionId: string,
    totalUsage: Usage,
    totalCostUsd: number,
    turnCount: number,
    lastPrompt?: string,
  ): Promise<void> {
    if (lastPrompt) {
      const normalized = previewText(lastPrompt);
      if (normalized) {
        const lpEntry: SessionEntry = {
          type: "last-prompt",
          sessionId,
          timestamp: new Date().toISOString(),
          lastPrompt: normalized,
        } as SessionEntry;
        await this.appendEntry(sessionId, lpEntry);
      }
    }
    const entry: SessionEntry = {
      type: "session_end",
      sessionId,
      timestamp: new Date().toISOString(),
      totalUsage,
      totalCostUsd,
      turnCount,
    } as SessionEntry;
    await this.appendEntry(sessionId, entry);
  }

  /**
   * Write a custom title entry.
   */
  async writeTitle(sessionId: string, title: string): Promise<void> {
    const entry: SessionEntry = {
      type: "custom-title",
      sessionId,
      timestamp: new Date().toISOString(),
      customTitle: title,
    } as SessionEntry;
    await this.appendEntry(sessionId, entry);
  }

  /**
   * Write a branch marker entry.
   */
  async writeBranch(
    sessionId: string,
    params: {
      parentSessionId: string;
      forkedFromUuid?: string;
      title?: string;
      status?: BranchEntry["status"];
      worktreePath?: string;
      worktreeBranch?: string;
      baseCommit?: string;
    },
  ): Promise<void> {
    const entry: SessionEntry = {
      type: "branch",
      sessionId,
      timestamp: new Date().toISOString(),
      parentSessionId: params.parentSessionId,
      status: params.status ?? "active",
      ...(params.forkedFromUuid ? { forkedFromUuid: params.forkedFromUuid } : {}),
      ...(params.title ? { title: params.title } : {}),
      ...(params.worktreePath ? { worktreePath: params.worktreePath } : {}),
      ...(params.worktreeBranch ? { worktreeBranch: params.worktreeBranch } : {}),
      ...(params.baseCommit ? { baseCommit: params.baseCommit } : {}),
    } as SessionEntry;
    await this.appendEntry(sessionId, entry);
  }

  // ── Read / Query operations ───────────────────────────────────────────────

  /**
   * List sessions with optional filtering and pagination.
   * Returns SessionSummary objects compatible with the JSONL-based SessionStore.
   */
  async listSessions(
    opts: ListSessionsOptions = {},
    filter: SessionFilter = {},
  ): Promise<ListSessionsResult> {
    const query = this.buildStorageQuery(filter);
    const result = await this.storage.query(NAMESPACE, query);

    const allSummaries: SessionSummary[] = [];
    for (const { entry } of result.entries) {
      const stored = entry.value as unknown as StoredSession;
      const summary = extractSessionSummary(stored);
      if (summary) allSummaries.push(summary);
    }

    // Sort by last activity descending
    allSummaries.sort(
      (a, b) => b.lastActivityAt.getTime() - a.lastActivityAt.getTime(),
    );

    // Apply cwd filter if specified
    const filtered = opts.cwd
      ? allSummaries.filter((s) => s.cwd === opts.cwd)
      : allSummaries;

    const limit = opts.limit ?? filtered.length;
    const offset = opts.offset ?? 0;
    const sessions = filtered.slice(offset, offset + limit);
    const nextOffset =
      offset + sessions.length < filtered.length
        ? offset + sessions.length
        : undefined;

    return { sessions, totalCandidates: filtered.length, nextOffset };
  }

  /**
   * Load a session for resume (replay entries into Message[]).
   */
  async loadSession(sessionId: string): Promise<LoadedSession> {
    const stored = await this.getStoredSession(sessionId);
    if (!stored) throw new SessionNotFoundError(sessionId);

    const entries = parseJsonlLines(stored.content);
    const history: Message[] = [];
    let totalUsage: Usage = { input_tokens: 0, output_tokens: 0 };
    let totalCostUsd = 0;
    let turnCount = 0;
    let model = stored.metadata.model ?? "";
    let provider = stored.metadata.provider ?? "";
    const cwd = stored.metadata.cwd ?? "";

    for (const entry of entries) {
      if (entry.type === "user") {
        history.push({ role: "user", content: entry.content });
      } else if (entry.type === "assistant") {
        history.push({ role: "assistant", content: entry.content });
        totalUsage = addUsage(totalUsage, entry.usage);
        totalCostUsd += calculateCost(entry.usage, entry.model);
        turnCount++;
        model = entry.model;
        provider = entry.provider;
      } else if (entry.type === "session_end") {
        totalCostUsd = entry.totalCostUsd;
      }
    }

    return {
      sessionId,
      filePath: "", // SQLite has no file path
      cwd,
      history,
      totalUsage,
      totalCostUsd,
      turnCount,
      model,
      provider,
    };
  }

  /**
   * Load a session's raw entries for preview.
   */
  async loadEntries(sessionId: string): Promise<SessionEntry[]> {
    const stored = await this.getStoredSession(sessionId);
    if (!stored) throw new SessionNotFoundError(sessionId);
    return parseJsonlLines(stored.content);
  }

  /**
   * Get a session summary without loading all entries.
   */
  async getSessionSummary(sessionId: string): Promise<SessionSummary | null> {
    const stored = await this.getStoredSession(sessionId);
    if (!stored) return null;
    return extractSessionSummary(stored);
  }

  /**
   * Check if a session exists.
   */
  async hasSession(sessionId: string): Promise<boolean> {
    return this.storage.has(NAMESPACE, sessionId);
  }

  /**
   * Delete a session.
   */
  async deleteSession(sessionId: string): Promise<boolean> {
    return this.storage.delete(NAMESPACE, sessionId);
  }

  // ── Fork / Branch operations ──────────────────────────────────────────────

  /**
   * Fork a session: copy replayable entries to a new session and add branch marker.
   */
  async forkSession(options: ForkSessionOptions): Promise<ForkedSession> {
    const sourceStored = await this.getStoredSession(options.fromSessionId);
    if (!sourceStored) {
      throw new SessionNotFoundError(options.fromSessionId);
    }

    const sourceEntries = parseJsonlLines(sourceStored.content);
    const replayable = sourceEntries.filter(isReplayableSessionEntry);

    if (replayable.length === 0) {
      throw new SessionNotFoundError(options.fromSessionId);
    }

    const forkedFromUuid =
      options.atUuid ?? findLastMessageUuid(replayable);
    const newSessionId = crypto.randomUUID();
    const now = new Date().toISOString();

    // Build content from replayable entries with new sessionId
    let content = "";
    let firstPrompt: string | undefined;
    for (const entry of replayable) {
      const rewritten = { ...entry, sessionId: newSessionId };
      content += JSON.stringify(rewritten) + "\n";
      if (!firstPrompt && entry.type === "user") {
        firstPrompt = entry.content;
      }
    }

    // Add branch marker
    const branchEntry: SessionEntry = {
      type: "branch",
      sessionId: newSessionId,
      timestamp: now,
      parentSessionId: options.fromSessionId,
      status: "active",
      ...(forkedFromUuid ? { forkedFromUuid } : {}),
      ...(options.title ? { title: options.title } : {}),
      ...(options.worktreePath ? { worktreePath: options.worktreePath } : {}),
      ...(options.worktreeBranch
        ? { worktreeBranch: options.worktreeBranch }
        : {}),
      ...(options.baseCommit ? { baseCommit: options.baseCommit } : {}),
    } as SessionEntry;
    content += JSON.stringify(branchEntry) + "\n";

    // Add title if provided
    if (options.title) {
      const titleEntry: SessionEntry = {
        type: "custom-title",
        sessionId: newSessionId,
        timestamp: now,
        customTitle: `${options.title} (Branch)`,
      } as SessionEntry;
      content += JSON.stringify(titleEntry) + "\n";
    }

    const stored: StoredSession = {
      sessionId: newSessionId,
      content,
      createdAt: now,
      updatedAt: now,
      metadata: {
        model: sourceStored.metadata.model,
        provider: sourceStored.metadata.provider,
        cwd: sourceStored.metadata.cwd,
        firstPrompt,
        title: options.title
          ? `${options.title} (Branch)`
          : undefined,
        tags: ["fork"],
      },
    };

    await this.storage.set(
      NAMESPACE,
      newSessionId,
      stored as unknown as StorageValue,
    );

    return {
      sessionId: newSessionId,
      parentSessionId: options.fromSessionId,
      filePath: "", // SQLite has no file path
      ...(forkedFromUuid ? { forkedFromUuid } : {}),
      ...(options.title ? { title: options.title } : {}),
      ...(options.worktreePath ? { worktreePath: options.worktreePath } : {}),
      ...(options.worktreeBranch
        ? { worktreeBranch: options.worktreeBranch }
        : {}),
      ...(options.baseCommit ? { baseCommit: options.baseCommit } : {}),
    };
  }

  /**
   * List branches of a parent session.
   */
  async listBranches(parentSessionId: string): Promise<SessionSummary[]> {
    const { sessions } = await this.listSessions();
    return sessions.filter(
      (s) =>
        s.branch?.parentSessionId === parentSessionId &&
        s.branch.status !== "discarded",
    );
  }

  /**
   * Get the latest branch metadata for a session.
   */
  async getBranchMetadata(
    sessionId: string,
  ): Promise<BranchEntry | null> {
    const entries = await this.loadEntries(sessionId);
    const branchEntries = entries.filter(
      (e): e is Extract<SessionEntry, { type: "branch" }> =>
        e.type === "branch",
    );
    return branchEntries.length > 0
      ? (branchEntries[branchEntries.length - 1] ?? null)
      : null;
  }

  /**
   * Update branch status (discard / adopt / merge).
   */
  async updateBranchStatus(
    sessionId: string,
    status: BranchEntry["status"],
  ): Promise<void> {
    const branch = await this.getBranchMetadata(sessionId);
    if (!branch) throw new SessionNotFoundError(sessionId);

    await this.writeBranch(sessionId, {
      parentSessionId: branch.parentSessionId,
      forkedFromUuid: branch.forkedFromUuid,
      title: branch.title,
      status,
      worktreePath: branch.worktreePath,
      worktreeBranch: branch.worktreeBranch,
      baseCommit: branch.baseCommit,
    });
  }

  /**
   * Update the tags in session metadata.
   */
  async updateTags(sessionId: string, tags: string[]): Promise<void> {
    const stored = await this.getStoredSession(sessionId);
    if (!stored) throw new SessionNotFoundError(sessionId);
    stored.metadata.tags = tags;
    stored.updatedAt = new Date().toISOString();
    await this.storage.set(
      NAMESPACE,
      sessionId,
      stored as unknown as StorageValue,
    );
  }

  // ── Import / Export / Verification (SQ4) ────────────────────────────────────

  /**
   * Import a raw JSONL session into SQLite. Used during migration to store
   * the full original content without going through createSession + appendEntry.
   */
  async importSession(stored: StoredSession): Promise<void> {
    await this.storage.set(
      NAMESPACE,
      stored.sessionId,
      stored as unknown as StorageValue,
    );
  }

  /**
   * Export a session's raw JSONL content for backward compatibility with
   * tools that expect JSONL files.
   */
  async exportJsonl(sessionId: string): Promise<string> {
    const stored = await this.getStoredSession(sessionId);
    if (!stored) throw new SessionNotFoundError(sessionId);
    return stored.content;
  }

  /**
   * Verify that a migrated session matches its source JSONL content.
   * Returns a verification result with entry counts and integrity status.
   */
  async verifyMigration(
    sessionId: string,
    sourceContent: string,
  ): Promise<MigrationVerificationResult> {
    const stored = await this.getStoredSession(sessionId);
    if (!stored) {
      return {
        ok: false,
        sessionId,
        reason: "Session not found in SQLite after migration",
        sourceEntries: 0,
        migratedEntries: 0,
      };
    }

    const sourceLines = sourceContent.split("\n").filter(Boolean);
    const migratedLines = stored.content.split("\n").filter(Boolean);

    let sourceParseOk = 0;
    let sourceParseFail = 0;
    for (const line of sourceLines) {
      try { JSON.parse(line); sourceParseOk++; } catch { sourceParseFail++; }
    }

    let migratedParseOk = 0;
    let migratedParseFail = 0;
    for (const line of migratedLines) {
      try { JSON.parse(line); migratedParseOk++; } catch { migratedParseFail++; }
    }

    const contentMatch = stored.content === sourceContent;
    const entryCountMatch = sourceParseOk === migratedParseOk;
    const ok = contentMatch || (entryCountMatch && sourceParseFail === migratedParseFail);

    return {
      ok,
      sessionId,
      sourceEntries: sourceParseOk,
      migratedEntries: migratedParseOk,
      ...(contentMatch ? {} : { contentMatch: false }),
      ...(sourceParseFail > 0 ? { sourceCorruptLines: sourceParseFail } : {}),
      ...(migratedParseFail > 0 ? { migratedCorruptLines: migratedParseFail } : {}),
      ...(ok ? {} : { reason: "Entry count mismatch or content differs" }),
    };
  }

  // ── Internal helpers ──────────────────────────────────────────────────────

  private async getStoredSession(
    sessionId: string,
  ): Promise<StoredSession | null> {
    const val = await this.storage.get(NAMESPACE, sessionId);
    if (!val) return null;
    return val as unknown as StoredSession;
  }

  /**
   * Update metadata fields based on the type of entry being appended.
   */
  private updateMetadata(stored: StoredSession, entry: SessionEntry): void {
    const meta = stored.metadata;

    if (entry.type === "user" && !meta.firstPrompt) {
      meta.firstPrompt = previewText(entry.content);
    } else if (entry.type === "assistant") {
      meta.turnCount = (meta.turnCount ?? 0) + 1;
      meta.model = entry.model;
      meta.provider = entry.provider;
    } else if (entry.type === "session_end") {
      meta.turnCount = entry.turnCount;
      meta.totalCostUsd = entry.totalCostUsd;
    } else if (entry.type === "custom-title" || entry.type === "custom_title") {
      meta.title = entry.customTitle ?? entry.title;
    } else if (entry.type === "ai-title") {
      if (!meta.title) meta.title = entry.aiTitle;
    } else if (entry.type === "tag") {
      const tags = meta.tags ? [...meta.tags] : [];
      if (!tags.includes(entry.tag)) tags.push(entry.tag);
      meta.tags = tags;
    }
  }

  /**
   * Build a StorageQuery from a SessionFilter, using prefixed tags for
   * model/provider/cwd filtering.
   */
  private buildStorageQuery(filter: SessionFilter): StorageQuery {
    const tags: string[] = [];

    if (filter.model) tags.push(`model:${filter.model}`);
    if (filter.provider) tags.push(`provider:${filter.provider}`);
    if (filter.cwd) tags.push(`cwd:${filter.cwd}`);
    if (filter.tags) {
      for (const t of filter.tags) {
        if (!tags.includes(t)) tags.push(t);
      }
    }

    return {
      ...(tags.length > 0 ? { tags } : {}),
      ...(filter.createdAfter ? { createdAfter: filter.createdAfter } : {}),
      ...(filter.createdBefore
        ? { createdBefore: filter.createdBefore }
        : {}),
      ...(filter.limit !== undefined ? { limit: filter.limit } : {}),
      ...(filter.offset !== undefined ? { offset: filter.offset } : {}),
      orderBy: filter.orderBy === "updatedAt" ? "updatedAt" : "createdAt",
      order: filter.order ?? "desc",
      ...(filter.fullTextSearch
        ? { fullTextSearch: filter.fullTextSearch }
        : {}),
    };
  }
}

// ── Migration ───────────────────────────────────────────────────────────────

/**
 * Migrate all JSONL session files from a directory into a
 * SessionStorageAdapter. Returns the count of migrated sessions.
 */
export async function migrateJsonlToSqlite(
  adapter: SessionStorageAdapter,
  sessionsDir: string,
): Promise<number> {
  let migrated = 0;

  let files: string[];
  try {
    files = readdirSync(sessionsDir).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return 0;
  }

  for (const file of files) {
    const sessionId = file.slice(0, -".jsonl".length);
    const filePath = join(sessionsDir, file);

    try {
      const stat = statSync(filePath);
      if (stat.size <= 0) continue;

      const raw = readFileSync(filePath, "utf8");
      const entries = parseJsonlLines(raw);
      if (entries.length === 0) continue;

      // Skip if already migrated
      if (await adapter.hasSession(sessionId)) continue;

      // Extract metadata from entries
      const meta = extractMetadataFromEntries(entries);

      const stored: StoredSession = {
        sessionId,
        content: raw,
        createdAt: entries[0]?.timestamp ?? new Date().toISOString(),
        updatedAt: stat.mtime.toISOString(),
        metadata: meta,
      };

      // Import session directly using the public importSession API
      await adapter.importSession(stored);

      migrated++;
    } catch {
      // Skip files that cannot be read
    }
  }

  return migrated;
}

// ── JSONL parsing ───────────────────────────────────────────────────────────

function parseJsonlLine(line: string): SessionEntry | null {
  try {
    return JSON.parse(line) as SessionEntry;
  } catch {
    return null;
  }
}

function parseJsonlLines(raw: string): SessionEntry[] {
  return raw
    .split("\n")
    .filter(Boolean)
    .map(parseJsonlLine)
    .filter((e): e is SessionEntry => e !== null);
}

function isReplayableSessionEntry(entry: SessionEntry): boolean {
  return (
    entry.type !== "session_end" &&
    entry.type !== "last_prompt" &&
    entry.type !== "last-prompt" &&
    entry.type !== "summary" &&
    entry.type !== "ai-title" &&
    entry.type !== "tag" &&
    entry.type !== "git-branch" &&
    entry.type !== "pr-link" &&
    entry.type !== "branch"
  );
}

function findLastMessageUuid(entries: SessionEntry[]): string | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!;
    if ("uuid" in entry) return entry.uuid;
  }
  return undefined;
}

// ── Usage helpers ───────────────────────────────────────────────────────────

function addUsage(a: Usage, b: Usage): Usage {
  return {
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
    cache_creation_input_tokens:
      (a.cache_creation_input_tokens ?? 0) +
      (b.cache_creation_input_tokens ?? 0),
    cache_read_input_tokens:
      (a.cache_read_input_tokens ?? 0) + (b.cache_read_input_tokens ?? 0),
  };
}

function previewText(content: string | undefined): string | undefined {
  const normalized = content?.replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  return normalized.length > 120
    ? `${normalized.slice(0, 117)}...`
    : normalized;
}

// ── Summary extraction ──────────────────────────────────────────────────────

/**
 * Extract metadata from raw session entries (used during migration).
 */
function extractMetadataFromEntries(entries: SessionEntry[]): SessionMetadata {
  let model: string | undefined;
  let provider: string | undefined;
  let cwd: string | undefined;
  let turnCount = 0;
  let totalCostUsd = 0;
  let title: string | undefined;
  let firstPrompt: string | undefined;
  const tags: string[] = [];

  for (const entry of entries) {
    if (entry.type === "session_start") {
      model = entry.model;
      provider = entry.provider;
      cwd = entry.cwd;
    } else if (entry.type === "user" && !firstPrompt) {
      firstPrompt = previewText(entry.content);
    } else if (entry.type === "assistant") {
      turnCount++;
    } else if (entry.type === "session_end") {
      turnCount = entry.turnCount;
      totalCostUsd = entry.totalCostUsd;
    } else if (
      entry.type === "custom-title" ||
      entry.type === "custom_title"
    ) {
      title = entry.customTitle ?? entry.title;
    } else if (entry.type === "ai-title" && !title) {
      title = entry.aiTitle;
    } else if (entry.type === "tag") {
      if (!tags.includes(entry.tag)) tags.push(entry.tag);
    }
  }

  return {
    ...(model ? { model } : {}),
    ...(provider ? { provider } : {}),
    ...(cwd ? { cwd } : {}),
    ...(turnCount > 0 ? { turnCount } : {}),
    ...(totalCostUsd > 0 ? { totalCostUsd } : {}),
    ...(title ? { title } : {}),
    ...(firstPrompt ? { firstPrompt } : {}),
    ...(tags.length > 0 ? { tags } : {}),
  };
}

/**
 * Reconstruct a SessionSummary from a StoredSession.
 */
function extractSessionSummary(stored: StoredSession): SessionSummary | null {
  const entries = parseJsonlLines(stored.content);

  let turnCount = stored.metadata.turnCount ?? 0;
  let totalUsage: Usage = { input_tokens: 0, output_tokens: 0 };
  let totalCostUsd = stored.metadata.totalCostUsd ?? 0;
  let messageCount = 0;
  let model = stored.metadata.model ?? "";
  let provider = stored.metadata.provider ?? "";
  const cwd = stored.metadata.cwd ?? "";
  let customTitle = stored.metadata.title;
  let firstPrompt = stored.metadata.firstPrompt;
  let lastUserInput: string | undefined;
  let tag: string | undefined;
  let branch: SessionSummary["branch"];
  let foundEnd = false;

  // Scan entries for additional detail not in metadata
  for (const entry of entries) {
    if (entry.type === "session_start") {
      if (!model) model = entry.model;
      if (!provider) provider = entry.provider;
    } else if (entry.type === "user") {
      messageCount++;
      lastUserInput = entry.content;
      if (!firstPrompt) firstPrompt = previewText(entry.content);
    } else if (entry.type === "assistant") {
      messageCount++;
      totalUsage = addUsage(totalUsage, entry.usage);
      if (!foundEnd) {
        totalCostUsd += calculateCost(entry.usage, entry.model);
      }
      model = entry.model;
      provider = entry.provider;
    } else if (entry.type === "session_end") {
      turnCount = entry.turnCount;
      totalUsage = entry.totalUsage;
      totalCostUsd = entry.totalCostUsd;
      foundEnd = true;
    } else if (
      entry.type === "custom-title" ||
      entry.type === "custom_title"
    ) {
      customTitle = entry.customTitle ?? entry.title;
    } else if (entry.type === "ai-title" && !customTitle) {
      customTitle = entry.aiTitle;
    } else if (entry.type === "tag") {
      tag = entry.tag;
    } else if (entry.type === "branch") {
      branch = {
        parentSessionId: entry.parentSessionId,
        ...(entry.forkedFromUuid
          ? { forkedFromUuid: entry.forkedFromUuid }
          : {}),
        ...(entry.title ? { title: entry.title } : {}),
        status: entry.status,
        ...(entry.worktreePath
          ? { worktreePath: entry.worktreePath }
          : {}),
        ...(entry.worktreeBranch
          ? { worktreeBranch: entry.worktreeBranch }
          : {}),
        ...(entry.baseCommit
          ? { baseCommit: entry.baseCommit }
          : {}),
      };
    }
  }

  const displaySummary =
    previewText(customTitle) ??
    previewText(firstPrompt) ??
    stored.metadata.firstPrompt;
  if (!displaySummary) return null;

  return {
    sessionId: stored.sessionId,
    filePath: "", // SQLite has no file path
    startedAt: new Date(stored.createdAt),
    lastActivityAt: new Date(stored.updatedAt),
    model,
    provider,
    turnCount,
    messageCount: messageCount || undefined,
    totalUsage,
    totalCostUsd,
    cwd,
    createdAt: new Date(stored.createdAt),
    ...(customTitle ? { title: previewText(customTitle) } : {}),
    summary: displaySummary,
    ...(firstPrompt ? { firstPrompt: previewText(firstPrompt) } : {}),
    lastUserInput: previewText(lastUserInput),
    ...(tag ? { tag } : {}),
    ...(branch ? { branch } : {}),
  };
}
