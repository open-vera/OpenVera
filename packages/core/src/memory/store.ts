/**
 * Memory System — Three-tier memory for autonomous agents.
 *
 * Tiers:
 *   1. Working Memory  — volatile, per-session, current context
 *   2. Episodic Memory — persisted task-level summaries
 *   3. Semantic Memory — persisted knowledge facts (key-value with tags)
 *
 * Storage:
 *   - Working: in-memory Map (cleared on process exit)
 *   - Episodic/Semantic: JSONL files under a configurable directory
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// ─── Types ───────────────────────────────────────────────────────────────────

export type MemoryTier = "working" | "episodic" | "semantic";

export interface MemoryEntry {
  id: string;
  tier: MemoryTier;
  /** The actual content / knowledge */
  content: string;
  /** Tags for categorization and search */
  tags: string[];
  /** ISO timestamp */
  createdAt: string;
  /** ISO timestamp (for eviction / staleness) */
  updatedAt: string;
  /** Optional source context (e.g., which task produced this) */
  source?: string;
  /** Importance score 0-1, used for eviction ranking */
  importance: number;
}

export interface EpisodicEntry extends MemoryEntry {
  tier: "episodic";
  /** What the task was about */
  taskSummary: string;
  /** What happened */
  outcome: string;
  /** What to remember */
  lessons: string[];
}

export interface SemanticEntry extends MemoryEntry {
  tier: "semantic";
  /** A concise knowledge claim */
  key: string;
  /** Supporting detail */
  value: string;
}

export interface MemoryStoreOptions {
  /** Directory for persisted memory (episodic + semantic). Required for persistence. */
  storeDir?: string;
  /** Max working memory entries before auto-eviction. Default: 200 */
  maxWorkingEntries?: number;
}

export interface MemorySearchResult {
  entry: MemoryEntry;
  score: number;
  matchedTerms: string[];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 6);
  return `mem-${ts}-${rand}`;
}

function now(): string {
  return new Date().toISOString();
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1);
}

/** Simple TF-IDF-like keyword extraction: returns top N terms by frequency. */
function extractKeywords(text: string, maxTerms = 20): string[] {
  const tokens = tokenize(text);
  const freq = new Map<string, number>();
  for (const t of tokens) {
    freq.set(t, (freq.get(t) ?? 0) + 1);
  }
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxTerms)
    .map(([term]) => term);
}

/** Keyword-based relevance score (Jaccard-like overlap). */
function keywordScore(queryTerms: string[], entryTerms: string[]): { score: number; matched: string[] } {
  if (queryTerms.length === 0 || entryTerms.length === 0) return { score: 0, matched: [] };
  const entrySet = new Set(entryTerms);
  const matched = queryTerms.filter((t) => entrySet.has(t));
  // Weighted: matched / min(query, entry) — favors entries that cover more query terms
  const denominator = Math.min(queryTerms.length, entryTerms.length);
  return { score: matched.length / denominator, matched };
}

// ─── Store ───────────────────────────────────────────────────────────────────

export class MemoryStore {
  /** Working memory — volatile, in-memory only */
  private working: MemoryEntry[] = [];
  /** Episodic memory — persisted */
  private episodic: EpisodicEntry[] = [];
  /** Semantic memory — persisted */
  private semantic: SemanticEntry[] = [];

  private readonly storeDir: string | null;
  private readonly maxWorking: number;

  constructor(options: MemoryStoreOptions = {}) {
    this.storeDir = options.storeDir ?? null;
    this.maxWorking = options.maxWorkingEntries ?? 200;

    if (this.storeDir) {
      mkdirSync(this.storeDir, { recursive: true });
      this.loadFromDisk();
    }
  }

  // ─── Working Memory ──────────────────────────────────────────────────────

  /**
   * Add a working memory entry (volatile, session-scoped).
   */
  addWorking(content: string, tags: string[] = [], source?: string, importance = 0.5): MemoryEntry {
    const entry: MemoryEntry = {
      id: makeId(),
      tier: "working",
      content,
      tags,
      createdAt: now(),
      updatedAt: now(),
      source,
      importance,
    };
    this.working.push(entry);
    this.evictWorking();
    return entry;
  }

  /**
   * Get all working memory entries.
   */
  getWorking(): MemoryEntry[] {
    return [...this.working];
  }

  /**
   * Clear working memory (e.g., on session end).
   */
  clearWorking(): void {
    this.working = [];
  }

  // ─── Episodic Memory ─────────────────────────────────────────────────────

  /**
   * Record an episodic memory — a task-level summary of what happened.
   */
  addEpisodic(
    taskSummary: string,
    outcome: string,
    lessons: string[],
    tags: string[] = [],
    source?: string,
    importance = 0.7
  ): EpisodicEntry {
    const entry: EpisodicEntry = {
      id: makeId(),
      tier: "episodic",
      content: `${taskSummary}\n\nOutcome: ${outcome}\n\nLessons: ${lessons.join("; ")}`,
      tags,
      createdAt: now(),
      updatedAt: now(),
      source,
      importance,
      taskSummary,
      outcome,
      lessons,
    };
    this.episodic.push(entry);
    this.persistEntry(entry);
    return entry;
  }

  /**
   * Get all episodic memory entries.
   */
  getEpisodic(): EpisodicEntry[] {
    return [...this.episodic];
  }

  // ─── Semantic Memory ─────────────────────────────────────────────────────

  /**
   * Store a semantic memory — a knowledge fact.
   */
  addSemantic(
    key: string,
    value: string,
    tags: string[] = [],
    source?: string,
    importance = 0.8
  ): SemanticEntry {
    // Deduplicate: if key already exists, update instead of duplicate
    const existing = this.semantic.find((e) => e.key === key);
    if (existing) {
      existing.value = value;
      existing.tags = [...new Set([...existing.tags, ...tags])];
      existing.updatedAt = now();
      existing.importance = Math.max(existing.importance, importance);
      this.persistAll();
      return existing;
    }

    const entry: SemanticEntry = {
      id: makeId(),
      tier: "semantic",
      content: `${key}: ${value}`,
      tags,
      createdAt: now(),
      updatedAt: now(),
      source,
      importance,
      key,
      value,
    };
    this.semantic.push(entry);
    this.persistEntry(entry);
    return entry;
  }

  /**
   * Get all semantic memory entries.
   */
  getSemantic(): SemanticEntry[] {
    return [...this.semantic];
  }

  /**
   * Remove a semantic memory by key.
   */
  removeSemantic(key: string): boolean {
    const idx = this.semantic.findIndex((e) => e.key === key);
    if (idx === -1) return false;
    this.semantic.splice(idx, 1);
    this.persistAll();
    return true;
  }

  // ─── Search ──────────────────────────────────────────────────────────────

  /**
   * Search across all memory tiers for relevant entries.
   * Returns results sorted by relevance (highest first).
   */
  search(query: string, options: { tiers?: MemoryTier[]; limit?: number } = {}): MemorySearchResult[] {
    const tiers = options.tiers ?? ["working", "episodic", "semantic"];
    const limit = options.limit ?? 10;
    const queryTerms = extractKeywords(query);

    const allEntries: MemoryEntry[] = [
      ...(tiers.includes("working") ? this.working : []),
      ...(tiers.includes("episodic") ? this.episodic : []),
      ...(tiers.includes("semantic") ? this.semantic : []),
    ];

    const results: MemorySearchResult[] = [];

    for (const entry of allEntries) {
      const entryTerms = tokenize(entry.content + " " + entry.tags.join(" "));
      const { score, matched } = keywordScore(queryTerms, entryTerms);

      // Require at least some keyword overlap
      if (score === 0) continue;

      // Also boost by importance
      const adjustedScore = score * 0.7 + entry.importance * 0.3;

      results.push({ entry, score: adjustedScore, matchedTerms: matched });
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }

  /**
   * Get memory stats.
   */
  stats(): { working: number; episodic: number; semantic: number; total: number } {
    return {
      working: this.working.length,
      episodic: this.episodic.length,
      semantic: this.semantic.length,
      total: this.working.length + this.episodic.length + this.semantic.length,
    };
  }

  // ─── Persistence ─────────────────────────────────────────────────────────

  private loadFromDisk(): void {
    if (!this.storeDir) return;
    this.episodic = this.loadJsonl<EpisodicEntry>("episodic.jsonl");
    this.semantic = this.loadJsonl<SemanticEntry>("semantic.jsonl");
  }

  private persistEntry(entry: MemoryEntry): void {
    if (!this.storeDir) return;
    const filename = entry.tier === "episodic" ? "episodic.jsonl" : "semantic.jsonl";
    const filePath = join(this.storeDir, filename);
    writeFileSync(filePath, JSON.stringify(entry) + "\n", { flag: "a" });
  }

  private persistAll(): void {
    if (!this.storeDir) return;
    this.writeJsonl("episodic.jsonl", this.episodic);
    this.writeJsonl("semantic.jsonl", this.semantic);
  }

  private loadJsonl<T>(filename: string): T[] {
    if (!this.storeDir) return [];
    const filePath = join(this.storeDir, filename);
    if (!existsSync(filePath)) return [];
    try {
      const raw = readFileSync(filePath, "utf-8");
      const lines = raw.trim().split("\n").filter(Boolean);
      const entries: T[] = [];
      for (const line of lines) {
        try {
          entries.push(JSON.parse(line) as T);
        } catch {
          // Skip corrupt lines
        }
      }
      return entries;
    } catch {
      return [];
    }
  }

  private writeJsonl<T>(filename: string, entries: T[]): void {
    if (!this.storeDir) return;
    const filePath = join(this.storeDir, filename);
    const content = entries.map((e) => JSON.stringify(e)).join("\n") + (entries.length > 0 ? "\n" : "");
    writeFileSync(filePath, content);
  }

  private evictWorking(): void {
    if (this.working.length <= this.maxWorking) return;
    // Sort by importance ascending, evict least important
    this.working.sort((a, b) => a.importance - b.importance);
    this.working = this.working.slice(this.working.length - this.maxWorking);
  }
}

// ─── Exports ─────────────────────────────────────────────────────────────────

export { extractKeywords, tokenize };
