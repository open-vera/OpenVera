// SessionManager — auto-compression, dedup, indexing, lifecycle

import { readdirSync, statSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { Message } from "../types/message.js";
import type { LLMAdapter } from "../adapters/base.js";
import type { LlmService } from "../adapters/llm-service.js";
import {
  compressMessages,
  type CompressionState,
  type CompressionOptions,
  createCompressionState,
} from "../context/compression.js";
import { estimateMessageTokens } from "../context/tokens.js";
import type {
  SessionSummary,
  ListSessionsOptions,
} from "./types.js";
import { SessionStore } from "./store.js";

// ── Types ──────────────────────────────────────────────────────────────────

export interface SessionManagerOptions {
  /** SS1: Auto-compression settings. */
  autoCompress?: {
    enabled: boolean;
    /** Token threshold to trigger compression. Default: 100_000 */
    tokenThreshold?: number;
    /** Keep recent turns uncompressed. Default: 6 */
    keepRecentTurns?: number;
    /** Model for compression. Default: same as main model */
    model?: string;
  };
  /** SS4: TTL in days for session cleanup. Default: 30 */
  ttlDays?: number;
  /** SS4: Max sessions to keep per project. Default: 1000 */
  maxSessions?: number;
}

export interface SessionIndexEntry {
  sessionId: string;
  filePath: string;
  title?: string;
  summary?: string;
  firstPrompt?: string;
  keywords: string[];
  lastActivityAt: Date;
  turnCount: number;
  cwd: string;
}

export interface CleanupResult {
  removedCount: number;
  removedSessionIds: string[];
  remainingCount: number;
}

export interface SimilarSession {
  session: SessionSummary;
  similarity: number;
  matchReason: string;
}

// ── SessionManager ─────────────────────────────────────────────────────────

export class SessionManager {
  private readonly options: Required<SessionManagerOptions>;
  private compressionStates = new Map<string, CompressionState>();
  private sessionIndex = new Map<string, SessionIndexEntry>();

  constructor(options: SessionManagerOptions = {}) {
    this.options = {
      autoCompress: options.autoCompress ?? { enabled: false },
      ttlDays: options.ttlDays ?? 30,
      maxSessions: options.maxSessions ?? 1000,
    };
  }

  // ── SS1: Auto-compression ───────────────────────────────────────────────

  /**
   * Compress messages if they exceed the token threshold.
   * Returns the (possibly compressed) messages and whether compression occurred.
   */
  async autoCompress(
    sessionId: string,
    messages: Message[],
    llm: LLMAdapter | LlmService,
    model: string,
  ): Promise<{ messages: Message[]; compressed: boolean; usage?: import("../types/index.js").Usage }> {
    const { autoCompress } = this.options;
    if (!autoCompress.enabled) {
      return { messages, compressed: false };
    }

    const state = this.compressionStates.get(sessionId) ?? createCompressionState();
    const compressionOpts: CompressionOptions = {
      enabled: true,
      triggerTokens: autoCompress.tokenThreshold ?? 100_000,
      keepRecentTurns: autoCompress.keepRecentTurns ?? 6,
      model: autoCompress.model ?? model,
    };

    const compressionAdapter = isLlmService(llm)
      ? llm.buildAdapter(undefined, compressionOpts.model, { purpose: "compression" })
      : llm;
    const result = await compressMessages(messages, state, compressionOpts, compressionAdapter, model);

    if (result.messages !== messages) {
      this.compressionStates.set(sessionId, result.state);
      return { messages: result.messages, compressed: true, usage: result.usage };
    }

    return { messages, compressed: false };
  }

  /** Get the compression state for a session. */
  getCompressionState(sessionId: string): CompressionState {
    return this.compressionStates.get(sessionId) ?? createCompressionState();
  }

  /** Clear compression state for a session (e.g., on session end). */
  clearCompressionState(sessionId: string): void {
    this.compressionStates.delete(sessionId);
  }

  // ── SS2: Session dedup & merge ──────────────────────────────────────────

  /**
   * Find sessions similar to the given one based on title, first prompt, and summary.
   * Returns matches sorted by similarity (highest first).
   */
  findSimilarSessions(
    targetSessionId: string,
    candidates: SessionSummary[],
    threshold = 0.6,
  ): SimilarSession[] {
    const target = candidates.find((s) => s.sessionId === targetSessionId);
    if (!target) return [];

    const targetText = this.extractSessionText(target);
    if (!targetText) return [];

    const results: SimilarSession[] = [];

    for (const candidate of candidates) {
      if (candidate.sessionId === targetSessionId) continue;

      const candidateText = this.extractSessionText(candidate);
      if (!candidateText) continue;

      const similarity = this.computeSimilarity(targetText, candidateText);
      if (similarity >= threshold) {
        results.push({
          session: candidate,
          similarity,
          matchReason: this.describeSimilarity(target, candidate),
        });
      }
    }

    return results.sort((a, b) => b.similarity - a.similarity);
  }

  /**
   * Merge duplicate sessions: keep the primary, mark others as merged.
   * The primary session gets a summary entry noting the merge.
   */
  mergeSessions(primaryId: string, duplicateIds: string[]): void {
    const primaryStore = new SessionStore({ sessionId: primaryId });

    for (const dupId of duplicateIds) {
      const dupStore = new SessionStore({ sessionId: dupId });
      // Write a tag to the duplicate marking it as merged
      dupStore.writeTag(`merged-into:${primaryId}`);

      // Write a tag to the primary noting the merge source
      primaryStore.writeTag(`merged-from:${dupId}`);
    }
  }

  // ── SS3: Session index ──────────────────────────────────────────────────

  /**
   * Build an in-memory index from session summaries for fast keyword search.
   */
  buildIndex(summaries: SessionSummary[]): void {
    this.sessionIndex.clear();

    for (const summary of summaries) {
      const keywords = this.extractKeywords(summary);
      this.sessionIndex.set(summary.sessionId, {
        sessionId: summary.sessionId,
        filePath: summary.filePath,
        title: summary.title,
        summary: summary.summary,
        firstPrompt: summary.firstPrompt,
        keywords,
        lastActivityAt: summary.lastActivityAt,
        turnCount: summary.turnCount,
        cwd: summary.cwd,
      });
    }
  }

  /**
   * Search the index by keyword. Returns matching sessions sorted by relevance.
   */
  searchByKeyword(query: string): SessionIndexEntry[] {
    const queryLower = query.toLowerCase();
    const queryTerms = queryLower.split(/\s+/).filter(Boolean);

    const results: Array<{ entry: SessionIndexEntry; score: number }> = [];

    for (const entry of this.sessionIndex.values()) {
      let score = 0;
      const searchText = [
        entry.title ?? "",
        entry.summary ?? "",
        entry.firstPrompt ?? "",
        ...entry.keywords,
      ].join(" ").toLowerCase();

      for (const term of queryTerms) {
        if (searchText.includes(term)) {
          score++;
          // Bonus for title match
          if (entry.title?.toLowerCase().includes(term)) score += 2;
          // Bonus for keyword match
          if (entry.keywords.some((k) => k.includes(term))) score += 1;
        }
      }

      if (score > 0) {
        results.push({ entry, score });
      }
    }

    return results
      .sort((a, b) => b.score - a.score)
      .map((r) => r.entry);
  }

  /**
   * Get index stats.
   */
  getIndexSize(): number {
    return this.sessionIndex.size;
  }

  // ── SS4: Lifecycle management ───────────────────────────────────────────

  /**
   * Clean up expired sessions based on TTL and max sessions per project.
   * Returns details of what was removed.
   */
  cleanup(opts?: { cwd?: string; dryRun?: boolean }): CleanupResult {
    const ttlMs = this.options.ttlDays * 24 * 60 * 60 * 1000;
    const cutoff = Date.now() - ttlMs;
    const removedSessionIds: string[] = [];

    const sessions = SessionStore.listSessionsPaged({
      cwd: opts?.cwd,
      limit: 0,
    }).sessions;

    // Phase 1: Remove sessions older than TTL
    for (const session of sessions) {
      const mtime = session.lastActivityAt.getTime();
      if (ttlMs <= 0 || mtime <= cutoff) {
        removedSessionIds.push(session.sessionId);
        if (!opts?.dryRun) {
          this.safeDelete(session.filePath);
        }
      }
    }

    // Phase 2: If still over max, remove oldest sessions
    const remaining = sessions.filter(
      (s) => !removedSessionIds.includes(s.sessionId)
    );

    if (remaining.length > this.options.maxSessions) {
      const toRemove = remaining
        .sort((a, b) => a.lastActivityAt.getTime() - b.lastActivityAt.getTime())
        .slice(0, remaining.length - this.options.maxSessions);

      for (const session of toRemove) {
        removedSessionIds.push(session.sessionId);
        if (!opts?.dryRun) {
          this.safeDelete(session.filePath);
        }
      }
    }

    return {
      removedCount: removedSessionIds.length,
      removedSessionIds,
      remainingCount: sessions.length - removedSessionIds.length,
    };
  }

  /**
   * Get sessions sorted by activity (most recent first).
   */
  listByActivity(opts?: ListSessionsOptions): SessionSummary[] {
    return SessionStore.listSessionsPaged(opts).sessions;
  }

  // ── Internal helpers ────────────────────────────────────────────────────

  private extractSessionText(session: SessionSummary): string {
    return [
      session.title ?? "",
      session.summary ?? "",
      session.firstPrompt ?? "",
      session.lastUserInput ?? "",
    ].join(" ").trim();
  }

  /**
   * Simple Jaccard similarity on character trigrams.
   * Fast, no external dependency, works well for short texts.
   */
  private computeSimilarity(a: string, b: string): number {
    const trigramsA = this.trigrams(a);
    const trigramsB = this.trigrams(b);

    if (trigramsA.size === 0 || trigramsB.size === 0) return 0;

    let intersection = 0;
    for (const t of trigramsA) {
      if (trigramsB.has(t)) intersection++;
    }

    const union = trigramsA.size + trigramsB.size - intersection;
    return union > 0 ? intersection / union : 0;
  }

  private trigrams(text: string): Set<string> {
    const normalized = text.toLowerCase().replace(/\s+/g, " ").trim();
    const result = new Set<string>();
    for (let i = 0; i <= normalized.length - 3; i++) {
      result.add(normalized.slice(i, i + 3));
    }
    return result;
  }

  private describeSimilarity(a: SessionSummary, b: SessionSummary): string {
    const reasons: string[] = [];
    if (a.title && b.title && a.title === b.title) reasons.push("same title");
    if (a.firstPrompt && b.firstPrompt) {
      const sim = this.computeSimilarity(a.firstPrompt, b.firstPrompt);
      if (sim > 0.7) reasons.push("similar first prompt");
    }
    if (a.gitBranch && b.gitBranch && a.gitBranch === b.gitBranch) {
      reasons.push("same git branch");
    }
    if (a.summary && b.summary) {
      const sim = this.computeSimilarity(a.summary, b.summary);
      if (sim > 0.5) reasons.push("similar summary");
    }
    return reasons.length > 0 ? reasons.join(", ") : "similar content";
  }

  private extractKeywords(summary: SessionSummary): string[] {
    const text = [
      summary.title ?? "",
      summary.summary ?? "",
      summary.firstPrompt ?? "",
    ].join(" ");

    // Extract words, filter stop words, deduplicate
    const stopWords = new Set([
      "the", "a", "an", "is", "are", "was", "were", "be", "been",
      "to", "of", "in", "for", "on", "with", "at", "by", "from",
      "this", "that", "it", "and", "or", "but", "not", "can", "will",
      "do", "did", "has", "have", "had", "i", "you", "we", "they",
      "的", "了", "是", "在", "不", "我", "有", "这", "他", "她", "它",
      "们", "就", "也", "和", "你", "要", "把", "那", "会", "到",
    ]);

    const words = text
      .toLowerCase()
      .replace(/[^\w一-鿿\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 2 && !stopWords.has(w));

    return [...new Set(words)].slice(0, 50);
  }

  private safeDelete(filePath: string): void {
    try {
      unlinkSync(filePath);
    } catch {
      // File may already be deleted or inaccessible
    }
  }
}

function isLlmService(value: LLMAdapter | LlmService): value is LlmService {
  return typeof (value as LlmService).buildAdapter === "function";
}
