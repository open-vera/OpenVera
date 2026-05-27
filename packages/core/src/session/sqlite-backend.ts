/**
 * SQLite-backed SessionStoreBackend.
 *
 * Wraps SessionStorageAdapter (which wraps SqliteStorageProvider) to implement
 * the SessionStoreBackend interface. Stores JSONL content inside SQLite while
 * providing query/filter/index capabilities.
 */

import type { StopReason, Usage } from "../types/index.js";
import type { Message } from "../types/message.js";
import type { StorageValue, StoredSession } from "../storage/types.js";
import { SqliteStorageProvider } from "../storage/sqlite.js";
import { SessionStorageAdapter, migrateJsonlToSqlite } from "../storage/session-adapter.js";
import { SessionNotFoundError, SessionNotBranchError } from "../errors.js";
import type {
  BranchEntry,
  ForkedSession,
  ForkSessionOptions,
  ListSessionsOptions,
  ListSessionsResult,
  LoadedSession,
  SessionEntry,
  SessionSummary,
  SessionTranscriptPreview,
} from "./types.js";
import type { SessionStoreBackend } from "./backend.js";

// ── SQLiteSessionBackend ────────────────────────────────────────────────────

export class SQLiteSessionBackend implements SessionStoreBackend {
  readonly name = "sqlite";

  private adapter: SessionStorageAdapter;
  private storage: SqliteStorageProvider;
  private initialized = false;

  constructor(dbPath: string, enableFts = false) {
    this.storage = new SqliteStorageProvider({
      backend: "sqlite",
      dbPath,
      enableFts,
    });
    this.adapter = new SessionStorageAdapter(this.storage);
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.adapter.initialize();
    this.initialized = true;
  }

  async close(): Promise<void> {
    if (!this.initialized) return;
    await this.adapter.close();
    this.initialized = false;
  }

  isHealthy(): boolean {
    return this.initialized && this.adapter.isHealthy();
  }

  // ── Write operations ──────────────────────────────────────────────────────

  writeStart(sessionId: string, cwd: string, model: string, provider: string): void {
    const now = new Date().toISOString();
    const startEntry: SessionEntry = {
      type: "session_start",
      sessionId,
      timestamp: now,
      cwd,
      model,
      provider,
    };
    this.setStoredSessionSync({
      sessionId,
      content: `${JSON.stringify(startEntry)}\n`,
      createdAt: now,
      updatedAt: now,
      metadata: { model, provider, cwd },
    });
  }

  writeTitle(sessionId: string, _cwd: string, title: string): void {
    this.appendEntrySync(sessionId, {
      type: "custom-title",
      sessionId,
      timestamp: new Date().toISOString(),
      customTitle: title,
    });
  }

  writeAiTitle(sessionId: string, _cwd: string, aiTitle: string): void {
    this.appendEntrySync(sessionId, {
      type: "ai-title",
      sessionId,
      timestamp: new Date().toISOString(),
      aiTitle,
    });
  }

  writeSummary(sessionId: string, _cwd: string, summary: string): void {
    this.appendEntrySync(sessionId, {
      type: "summary",
      sessionId,
      timestamp: new Date().toISOString(),
      summary,
    });
  }

  writeTag(sessionId: string, _cwd: string, tag: string): void {
    this.appendEntrySync(sessionId, {
      type: "tag",
      sessionId,
      timestamp: new Date().toISOString(),
      tag,
    });
  }

  writeGitBranch(sessionId: string, _cwd: string, gitBranch: string): void {
    this.appendEntrySync(sessionId, {
      type: "git-branch",
      sessionId,
      timestamp: new Date().toISOString(),
      gitBranch,
    });
  }

  writePrLink(
    sessionId: string,
    _cwd: string,
    p: { prUrl: string; prRepository?: string; prNumber?: number },
  ): void {
    this.appendEntrySync(sessionId, {
      type: "pr-link",
      sessionId,
      timestamp: new Date().toISOString(),
      prUrl: p.prUrl,
      ...(p.prRepository ? { prRepository: p.prRepository } : {}),
      ...(p.prNumber ? { prNumber: p.prNumber } : {}),
    });
  }

  writeBranch(
    sessionId: string,
    _cwd: string,
    p: {
      parentSessionId: string;
      forkedFromUuid?: string;
      title?: string;
      status?: BranchEntry["status"];
      worktreePath?: string;
      worktreeBranch?: string;
      baseCommit?: string;
    },
  ): void {
    this.appendEntrySync(sessionId, {
      type: "branch",
      sessionId,
      timestamp: new Date().toISOString(),
      parentSessionId: p.parentSessionId,
      status: p.status ?? "active",
      ...(p.forkedFromUuid ? { forkedFromUuid: p.forkedFromUuid } : {}),
      ...(p.title ? { title: p.title } : {}),
      ...(p.worktreePath ? { worktreePath: p.worktreePath } : {}),
      ...(p.worktreeBranch ? { worktreeBranch: p.worktreeBranch } : {}),
      ...(p.baseCommit ? { baseCommit: p.baseCommit } : {}),
    });
  }

  writeUser(sessionId: string, _cwd: string, content: string): string {
    const uuid = crypto.randomUUID();
    this.appendEntrySync(sessionId, {
      type: "user",
      sessionId,
      timestamp: new Date().toISOString(),
      uuid,
      content,
    });
    return uuid;
  }

  writeAssistant(
    sessionId: string,
    _cwd: string,
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
  ): string {
    const uuid = crypto.randomUUID();
    this.appendEntrySync(sessionId, {
      type: "assistant",
      sessionId,
      timestamp: new Date().toISOString(),
      uuid,
      ...p,
    });
    return uuid;
  }

  writeToolCall(
    sessionId: string,
    _cwd: string,
    p: {
      parentUuid: string;
      toolName: string;
      toolCallId: string;
      arguments: Record<string, unknown>;
    },
  ): string {
    const uuid = crypto.randomUUID();
    this.appendEntrySync(sessionId, {
      type: "tool_call",
      sessionId,
      timestamp: new Date().toISOString(),
      uuid,
      ...p,
    });
    return uuid;
  }

  writeToolResult(
    sessionId: string,
    _cwd: string,
    p: {
      parentUuid: string;
      toolCallId: string;
      content: string;
    },
  ): void {
    this.appendEntrySync(sessionId, {
      type: "tool_result",
      sessionId,
      timestamp: new Date().toISOString(),
      uuid: crypto.randomUUID(),
      ...p,
    });
  }

  writeEnd(
    sessionId: string,
    _cwd: string,
    totalUsage: Usage,
    totalCostUsd: number,
    turnCount: number,
    lastPrompt?: string,
  ): void {
    const normalized = this.preview(lastPrompt);
    if (normalized) {
      this.appendEntrySync(sessionId, {
        type: "last-prompt",
        sessionId,
        timestamp: new Date().toISOString(),
        lastPrompt: normalized,
      });
    }
    this.appendEntrySync(sessionId, {
      type: "session_end",
      sessionId,
      timestamp: new Date().toISOString(),
      totalUsage,
      totalCostUsd,
      turnCount,
    });
  }

  // ── Query operations ──────────────────────────────────────────────────────

  listSessions(opts: ListSessionsOptions = {}): ListSessionsResult {
    // The adapter's listSessions is async, but the interface is sync.
    // We use a cached synchronous approach: query the storage directly.
    // This is a design tradeoff — the JSONL backend is sync (file I/O),
    // while SQLite is async. For the facade pattern we use synchronous
    // wrappers that block on the async calls.
    //
    // In practice, better-sqlite3 is synchronous, so the adapter's async
    // methods resolve immediately. We use a helper to run them synchronously.
    return this.listSessionsSync(opts);
  }

  private listSessionsSync(opts: ListSessionsOptions): ListSessionsResult {
    // Query all sessions from storage synchronously via better-sqlite3
    const allKeys = this.storage.listKeysSync("sessions");
    const summaries: SessionSummary[] = [];

    for (const key of allKeys) {
      try {
        const val = this.storage.getSync("sessions", key);
        if (!val) continue;
        const stored = val as unknown as StoredSession;
        const summary = this.extractSummary(stored);
        if (summary) summaries.push(summary);
      } catch {
        // skip corrupted entries
      }
    }

    // Sort by last activity descending
    summaries.sort((a, b) => b.lastActivityAt.getTime() - a.lastActivityAt.getTime());

    // Apply cwd filter
    const filtered = opts.cwd
      ? summaries.filter((s) => s.cwd === opts.cwd)
      : summaries;

    const limit = opts.limit ?? filtered.length;
    const offset = opts.offset ?? 0;
    const sessions = filtered.slice(offset, offset + limit);
    const nextOffset =
      offset + sessions.length < filtered.length
        ? offset + sessions.length
        : undefined;

    return { sessions, totalCandidates: filtered.length, nextOffset };
  }

  loadSession(sessionId: string, _cwd?: string): LoadedSession {
    const val = this.storage.getSync("sessions", sessionId);
    if (!val) throw new SessionNotFoundError(sessionId);
    const stored = val as unknown as StoredSession;
    return this.extractLoadedSession(stored);
  }

  loadTranscriptPreview(sessionId: string, _cwd?: string): SessionTranscriptPreview {
    const val = this.storage.getSync("sessions", sessionId);
    if (!val) throw new SessionNotFoundError(sessionId);
    const stored = val as unknown as StoredSession;
    return this.extractTranscriptPreview(stored);
  }

  // ── Branch operations ─────────────────────────────────────────────────────

  forkSession(options: ForkSessionOptions): ForkedSession {
    // Use the adapter's async forkSession synchronously
    return this.forkSessionSync(options);
  }

  private forkSessionSync(options: ForkSessionOptions): ForkedSession {
    const sourceVal = this.storage.getSync("sessions", options.fromSessionId);
    if (!sourceVal) throw new SessionNotFoundError(options.fromSessionId);

    const sourceStored = sourceVal as unknown as StoredSession;
    const entries = this.parseJsonlLines(sourceStored.content);
    const replayable = entries.filter(this.isReplayable);

    if (replayable.length === 0) {
      throw new SessionNotFoundError(options.fromSessionId);
    }

    const forkedFromUuid = options.atUuid ?? this.findLastMessageUuid(replayable);
    const newSessionId = crypto.randomUUID();
    const now = new Date().toISOString();

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
    const branchEntry: Record<string, unknown> = {
      type: "branch",
      sessionId: newSessionId,
      timestamp: now,
      parentSessionId: options.fromSessionId,
      status: "active",
      ...(forkedFromUuid ? { forkedFromUuid } : {}),
      ...(options.title ? { title: options.title } : {}),
      ...(options.worktreePath ? { worktreePath: options.worktreePath } : {}),
      ...(options.worktreeBranch ? { worktreeBranch: options.worktreeBranch } : {}),
      ...(options.baseCommit ? { baseCommit: options.baseCommit } : {}),
    };
    content += JSON.stringify(branchEntry) + "\n";

    if (options.title) {
      content += JSON.stringify({
        type: "custom-title",
        sessionId: newSessionId,
        timestamp: now,
        customTitle: `${options.title} (Branch)`,
      }) + "\n";
    }

    const metadata: StoredSession["metadata"] = {
      ...(sourceStored.metadata.model ? { model: sourceStored.metadata.model } : {}),
      ...(sourceStored.metadata.provider ? { provider: sourceStored.metadata.provider } : {}),
      ...(sourceStored.metadata.cwd ? { cwd: sourceStored.metadata.cwd } : {}),
      ...(firstPrompt ? { firstPrompt } : {}),
      ...(options.title ? { title: `${options.title} (Branch)` } : {}),
      tags: ["fork"],
    };
    const stored: StoredSession = {
      sessionId: newSessionId,
      content,
      createdAt: now,
      updatedAt: now,
      metadata,
    };

    this.setStoredSessionSync(stored);

    return {
      sessionId: newSessionId,
      parentSessionId: options.fromSessionId,
      filePath: "",
      ...(forkedFromUuid ? { forkedFromUuid } : {}),
      ...(options.title ? { title: options.title } : {}),
      ...(options.worktreePath ? { worktreePath: options.worktreePath } : {}),
      ...(options.worktreeBranch ? { worktreeBranch: options.worktreeBranch } : {}),
      ...(options.baseCommit ? { baseCommit: options.baseCommit } : {}),
    };
  }

  listBranches(parentSessionId: string, cwd?: string): SessionSummary[] {
    const { sessions } = this.listSessions({ cwd });
    return sessions.filter(
      (s) =>
        s.branch?.parentSessionId === parentSessionId &&
        s.branch.status !== "discarded",
    );
  }

  discardBranch(sessionId: string, _cwd?: string): void {
    this.updateBranchStatus(sessionId, "discarded");
  }

  adoptBranch(sessionId: string, _cwd?: string): void {
    this.updateBranchStatus(sessionId, "adopted");
  }

  markBranchMerged(sessionId: string, _cwd?: string): void {
    this.updateBranchStatus(sessionId, "merged");
  }

  // ── Migration ─────────────────────────────────────────────────────────────

  /**
   * Migrate JSONL session files from the given directory into SQLite.
   */
  async migrateFromJsonl(sessionsDir: string): Promise<number> {
    return migrateJsonlToSqlite(this.adapter, sessionsDir);
  }

  // ── Internal helpers ──────────────────────────────────────────────────────

  private updateBranchStatus(sessionId: string, status: BranchEntry["status"]): void {
    const val = this.storage.getSync("sessions", sessionId);
    if (!val) throw new SessionNotFoundError(sessionId);

    const stored = val as unknown as StoredSession;
    const entries = this.parseJsonlLines(stored.content);
    const branchEntries = entries.filter(
      (e): e is Extract<typeof e, { type: "branch" }> => e.type === "branch",
    );

    if (branchEntries.length === 0) {
      throw new SessionNotBranchError(sessionId);
    }

    const lastBranch = branchEntries[branchEntries.length - 1]!;
    const now = new Date().toISOString();
    const newEntry: SessionEntry = {
      type: "branch",
      sessionId,
      timestamp: now,
      parentSessionId: lastBranch.parentSessionId,
      forkedFromUuid: lastBranch.forkedFromUuid,
      title: lastBranch.title,
      status,
      worktreePath: lastBranch.worktreePath,
      worktreeBranch: lastBranch.worktreeBranch,
      baseCommit: lastBranch.baseCommit,
    };

    stored.content += JSON.stringify(newEntry) + "\n";
    stored.updatedAt = now;
    this.setStoredSessionSync(stored);
  }

  private appendEntrySync(sessionId: string, entry: SessionEntry): void {
    const val = this.storage.getSync("sessions", sessionId);
    if (!val) throw new SessionNotFoundError(sessionId);

    const stored = val as unknown as StoredSession;
    stored.content += `${JSON.stringify(entry)}\n`;
    stored.updatedAt = new Date().toISOString();
    this.updateMetadata(stored, entry);
    this.setStoredSessionSync(stored);
  }

  private setStoredSessionSync(stored: StoredSession): void {
    this.storage.setSync("sessions", stored.sessionId, stored as unknown as StorageValue);
  }

  private updateMetadata(stored: StoredSession, entry: SessionEntry): void {
    const meta = stored.metadata;

    if (entry.type === "user" && !meta.firstPrompt) {
      meta.firstPrompt = this.preview(entry.content);
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
      meta.title ??= entry.aiTitle;
    } else if (entry.type === "tag") {
      const tags = meta.tags ? [...meta.tags] : [];
      if (!tags.includes(entry.tag)) tags.push(entry.tag);
      meta.tags = tags;
    }
  }

  private extractSummary(stored: StoredSession): SessionSummary | null {
    const entries = this.parseJsonlLines(stored.content);
    const meta = stored.metadata;

    let turnCount = meta.turnCount ?? 0;
    let totalUsage: Usage = { input_tokens: 0, output_tokens: 0 };
    let totalCostUsd = meta.totalCostUsd ?? 0;
    let messageCount = 0;
    let model = meta.model ?? "";
    let provider = meta.provider ?? "";
    const cwd = meta.cwd ?? "";
    let customTitle = meta.title;
    let firstPrompt = meta.firstPrompt;
    let lastUserInput: string | undefined;
    let tag: string | undefined;
    let gitBranch: string | undefined;
    let branch: SessionSummary["branch"];
    let foundEnd = false;

    for (const entry of entries) {
      if (entry.type === "session_start") {
        if (!model) model = entry.model;
        if (!provider) provider = entry.provider;
      } else if (entry.type === "user") {
        messageCount++;
        lastUserInput = entry.content;
        if (!firstPrompt) firstPrompt = this.preview(entry.content);
      } else if (entry.type === "assistant") {
        messageCount++;
        totalUsage = this.addUsage(totalUsage, entry.usage);
        if (!foundEnd) {
          totalCostUsd += this.calculateCost(entry.usage, entry.model);
        }
        model = entry.model;
        provider = entry.provider;
      } else if (entry.type === "session_end") {
        turnCount = entry.turnCount;
        totalUsage = entry.totalUsage;
        totalCostUsd = entry.totalCostUsd;
        foundEnd = true;
      } else if (entry.type === "custom-title" || entry.type === "custom_title") {
        customTitle = entry.customTitle ?? entry.title;
      } else if (entry.type === "ai-title" && !customTitle) {
        customTitle = entry.aiTitle;
      } else if (entry.type === "tag") {
        tag = entry.tag;
      } else if (entry.type === "git-branch") {
        gitBranch = entry.gitBranch;
      } else if (entry.type === "branch") {
        branch = {
          parentSessionId: entry.parentSessionId,
          ...(entry.forkedFromUuid ? { forkedFromUuid: entry.forkedFromUuid } : {}),
          ...(entry.title ? { title: entry.title } : {}),
          status: entry.status,
          ...(entry.worktreePath ? { worktreePath: entry.worktreePath } : {}),
          ...(entry.worktreeBranch ? { worktreeBranch: entry.worktreeBranch } : {}),
          ...(entry.baseCommit ? { baseCommit: entry.baseCommit } : {}),
        };
      }
    }

    const displaySummary =
      this.preview(customTitle) ??
      this.preview(firstPrompt) ??
      meta.firstPrompt;
    if (!displaySummary) return null;

    return {
      sessionId: stored.sessionId,
      filePath: "",
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
      ...(customTitle ? { title: this.preview(customTitle) } : {}),
      summary: displaySummary,
      ...(firstPrompt ? { firstPrompt: this.preview(firstPrompt) } : {}),
      lastUserInput: this.preview(lastUserInput),
      ...(tag ? { tag } : {}),
      ...(gitBranch ? { gitBranch } : {}),
      ...(branch ? { branch } : {}),
    };
  }

  private extractLoadedSession(stored: StoredSession): LoadedSession {
    const entries = this.parseJsonlLines(stored.content);
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
        totalUsage = this.addUsage(totalUsage, entry.usage);
        totalCostUsd += this.calculateCost(entry.usage, entry.model);
        turnCount++;
        model = entry.model;
        provider = entry.provider;
      } else if (entry.type === "session_end") {
        totalCostUsd = entry.totalCostUsd;
      }
    }

    return {
      sessionId: stored.sessionId,
      filePath: "",
      cwd,
      history,
      totalUsage,
      totalCostUsd,
      turnCount,
      model,
      provider,
    };
  }

  private extractTranscriptPreview(stored: StoredSession): SessionTranscriptPreview {
    const entries = this.parseJsonlLines(stored.content);
    const messages: SessionTranscriptPreview["messages"] = [];
    const toolCallsByParent = new Map<string, Extract<SessionEntry, { type: "tool_call" }>[]>();
    const toolResultsByCallUuid = new Map<string, Extract<SessionEntry, { type: "tool_result" }>>();

    for (const entry of entries) {
      if (entry.type === "tool_call") {
        const existing = toolCallsByParent.get(entry.parentUuid) ?? [];
        existing.push(entry);
        toolCallsByParent.set(entry.parentUuid, existing);
      } else if (entry.type === "tool_result") {
        toolResultsByCallUuid.set(entry.parentUuid, entry);
      }
    }

    for (const entry of entries) {
      if (entry.type === "user") {
        messages.push({ role: "user", content: entry.content });
      } else if (entry.type === "assistant") {
        const toolUses = [
          ...(toolCallsByParent.get(entry.uuid) ?? []),
          ...(toolCallsByParent.get(entry.parentUuid) ?? []),
        ].map((tc) => {
          const result = toolResultsByCallUuid.get(tc.uuid);
          return {
            name: tc.toolName,
            args: tc.arguments,
            result: {
              ok: Boolean(result),
              content: result?.content ?? "(no tool result recorded)",
            },
          };
        });
        messages.push({
          role: "assistant",
          content: entry.content,
          ...(toolUses.length ? { toolUses } : {}),
        });
      }
    }

    return {
      sessionId: stored.sessionId,
      messages,
    };
  }

  private parseJsonlLines(raw: string): SessionEntry[] {
    return raw
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try { return JSON.parse(line) as SessionEntry; }
        catch { return null; }
      })
      .filter((e): e is SessionEntry => e !== null);
  }

  private isReplayable(entry: SessionEntry): boolean {
    const type = entry.type;
    return (
      type !== "session_end" &&
      type !== "last_prompt" &&
      type !== "last-prompt" &&
      type !== "summary" &&
      type !== "ai-title" &&
      type !== "tag" &&
      type !== "git-branch" &&
      type !== "pr-link" &&
      type !== "branch"
    );
  }

  private findLastMessageUuid(entries: SessionEntry[]): string | undefined {
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i]!;
      if ("uuid" in entry) return entry.uuid as string;
    }
    return undefined;
  }

  private addUsage(a: Usage, b: Usage): Usage {
    return {
      input_tokens: a.input_tokens + b.input_tokens,
      output_tokens: a.output_tokens + b.output_tokens,
      cache_creation_input_tokens:
        (a.cache_creation_input_tokens ?? 0) + (b.cache_creation_input_tokens ?? 0),
      cache_read_input_tokens:
        (a.cache_read_input_tokens ?? 0) + (b.cache_read_input_tokens ?? 0),
    };
  }

  private calculateCost(usage: Usage, model: string): number {
    // Delegate to the session cost module (simplified inline for sync access)
    const pricing: Record<string, { input: number; output: number }> = {
      "claude-opus-4-6": { input: 15, output: 75 },
      "claude-sonnet-4-6": { input: 3, output: 15 },
      "claude-haiku-4-5": { input: 0.8, output: 4 },
      "gpt-4o": { input: 2.5, output: 10 },
      "gpt-4o-mini": { input: 0.15, output: 0.6 },
    };
    const key = model.toLowerCase().replace(/-\d{8}$/, "").replace(/-(latest|preview|exp)$/, "");
    const p = pricing[key];
    if (!p) return 0;
    return (usage.input_tokens * p.input + usage.output_tokens * p.output) / 1_000_000;
  }

  private preview(content: string | undefined): string | undefined {
    const normalized = content?.replace(/\s+/g, " ").trim();
    if (!normalized) return undefined;
    return normalized.length > 120 ? `${normalized.slice(0, 117)}...` : normalized;
  }
}
