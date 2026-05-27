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

import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync, unlinkSync } from "node:fs";
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
  /** Max entries to keep in the inverted index (prevents unbounded memory growth). Default: 5000 */
  maxIndexEntries?: number;
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

/** Validate that a parsed JSON object is a plausible memory entry. */
function isValidMemoryEntry(obj: unknown): obj is MemoryEntry {
  if (typeof obj !== "object" || obj === null) return false;
  const e = obj as Record<string, unknown>;
  return (
    typeof e.id === "string" &&
    typeof e.tier === "string" &&
    ["working", "episodic", "semantic"].includes(e.tier as string) &&
    typeof e.content === "string" &&
    Array.isArray(e.tags) &&
    typeof e.createdAt === "string" &&
    typeof e.updatedAt === "string" &&
    typeof e.importance === "number"
  );
}

// ─── Inverted Index ──────────────────────────────────────────────────────────

/**
 * Lightweight inverted index: term → set of entry IDs.
 * Enables O(1) lookup per query term instead of O(n) full scan.
 */
class InvertedIndex {
  /** term → entry IDs */
  private index = new Map<string, Set<string>>();
  /** entry ID → set of indexed terms (for removal) */
  private reverseIndex = new Map<string, Set<string>>();
  /** entry ID → MemoryEntry (for fast lookup) */
  private entryStore = new Map<string, MemoryEntry>();
  /** FIFO queue for eviction */
  private insertionOrder: string[] = [];

  constructor(private readonly maxEntries: number = 5000) {}

  /**
   * Add an entry to the index.
   * Indexes content + tags as searchable terms.
   */
  add(entry: MemoryEntry): void {
    const terms = tokenize(entry.content + " " + entry.tags.join(" "));

    // Evict oldest if at capacity
    while (this.insertionOrder.length >= this.maxEntries) {
      const evictId = this.insertionOrder.shift()!;
      this.remove(evictId);
    }

    this.insertionOrder.push(entry.id);
    this.entryStore.set(entry.id, entry);
    const termSet = new Set<string>();

    for (const term of terms) {
      let ids = this.index.get(term);
      if (!ids) {
        ids = new Set<string>();
        this.index.set(term, ids);
      }
      ids.add(entry.id);
      termSet.add(term);
    }

    this.reverseIndex.set(entry.id, termSet);
  }

  /**
   * Remove an entry from the index by ID.
   */
  remove(id: string): void {
    const terms = this.reverseIndex.get(id);
    if (!terms) return;

    for (const term of terms) {
      const ids = this.index.get(term);
      if (ids) {
        ids.delete(id);
        if (ids.size === 0) this.index.delete(term);
      }
    }

    this.reverseIndex.delete(id);
    this.entryStore.delete(id);
  }

  /**
   * Search the index for entries matching the query terms.
   * Returns candidate entry IDs with the number of matching terms.
   * Time: O(k) where k = total IDs across all matching terms.
   */
  search(queryTerms: string[]): Map<string, number> {
    const matchCounts = new Map<string, number>();

    for (const term of queryTerms) {
      const ids = this.index.get(term);
      if (!ids) continue;
      for (const id of ids) {
        matchCounts.set(id, (matchCounts.get(id) ?? 0) + 1);
      }
    }

    return matchCounts;
  }

  /**
   * Get a stored entry by ID.
   */
  getEntry(id: string): MemoryEntry | undefined {
    return this.entryStore.get(id);
  }

  /**
   * Number of indexed entries.
   */
  get size(): number {
    return this.entryStore.size;
  }

  /**
   * Clear the entire index.
   */
  clear(): void {
    this.index.clear();
    this.reverseIndex.clear();
    this.entryStore.clear();
    this.insertionOrder = [];
  }
}

// ─── Store ───────────────────────────────────────────────────────────────────

export class MemoryStore {
  /** Working memory — volatile, in-memory only */
  private working: MemoryEntry[] = [];
  /** Episodic memory — persisted */
  private episodic: EpisodicEntry[] = [];
  /** Semantic memory — persisted */
  private semantic: SemanticEntry[] = [];

  /** Inverted index for fast keyword search */
  private readonly searchIndex: InvertedIndex;

  private readonly storeDir: string | null;
  private readonly maxWorking: number;

  /** Ensures only one write is in-flight at a time. Chained via promise. */
  private _writeLock: Promise<void> = Promise.resolve();
  /** Count of pending write operations in the lock chain (approx). */
  private _pendingWrites = 0;

  constructor(options: MemoryStoreOptions = {}) {
    this.storeDir = options.storeDir ?? null;
    this.maxWorking = options.maxWorkingEntries ?? 200;
    this.searchIndex = new InvertedIndex(options.maxIndexEntries ?? 5000);

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
    this.searchIndex.add(entry);
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
    // Remove working entries from the search index
    for (const entry of this.working) {
      this.searchIndex.remove(entry.id);
    }
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
    this.searchIndex.add(entry);
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
    this.searchIndex.add(entry);
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
    const removed = this.semantic.splice(idx, 1)[0]!;
    this.searchIndex.remove(removed.id);
    this.persistAll();
    return true;
  }

  // ─── Search ──────────────────────────────────────────────────────────────

  /**
   * Search across all memory tiers for relevant entries.
   * Uses an inverted index for O(k) lookup where k = matching entries,
   * instead of the previous O(n) full scan.
   * Returns results sorted by relevance (highest first).
   */
  search(query: string, options: { tiers?: MemoryTier[]; limit?: number } = {}): MemorySearchResult[] {
    const tiers = options.tiers ?? ["working", "episodic", "semantic"];
    const limit = options.limit ?? 10;
    const queryTerms = extractKeywords(query);

    if (queryTerms.length === 0) return [];

    // Use inverted index for O(k) candidate lookup
    const matchCounts = this.searchIndex.search(queryTerms);

    // Build a tier filter set for fast lookup
    const tierSet = new Set(tiers);

    const results: MemorySearchResult[] = [];

    for (const [entryId, matchedCount] of matchCounts) {
      const entry = this.searchIndex.getEntry(entryId);
      if (!entry) continue;

      // Filter by requested tiers
      if (!tierSet.has(entry.tier)) continue;

      // Score: proportion of query terms matched (like the old Jaccard)
      // but computed from the index instead of re-tokenizing
      const denominator = Math.min(queryTerms.length, matchedCount);
      const baseScore = denominator > 0 ? matchedCount / denominator : 0;

      if (baseScore === 0) continue;

      // Boost by importance
      const adjustedScore = baseScore * 0.7 + entry.importance * 0.3;

      // Collect matched terms for reporting
      const entryTerms = tokenize(entry.content + " " + entry.tags.join(" "));
      const entryTermSet = new Set(entryTerms);
      const matchedTerms = queryTerms.filter((t) => entryTermSet.has(t));

      results.push({ entry, score: adjustedScore, matchedTerms });
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
    const loadedEpisodic = this.loadJsonl<EpisodicEntry>("episodic.jsonl");
    const loadedSemantic = this.loadJsonl<SemanticEntry>("semantic.jsonl");
    this.episodic = loadedEpisodic;
    this.semantic = loadedSemantic;

    // Rebuild the inverted index from persisted data
    for (const entry of this.episodic) this.searchIndex.add(entry);
    for (const entry of this.semantic) this.searchIndex.add(entry);
  }

  /** Await this to flush all pending writes to disk. */
  async flush(): Promise<void> {
    // Remember the count of writes in-flight when we start flushing
    const writesSnapshot = this._pendingWrites;
    await this._writeLock;
    // All writes in the lock chain at snapshot time have now completed.
    // Yield once to the event loop so blocking writeFileSync finishes.
    await new Promise<void>((r) => setImmediate(r));
    // If writes were added during the above microtask (new lock assigned),
    // keep flushing until those complete too.
    if (this._pendingWrites > writesSnapshot) {
      await this.flush();
    }
  }

  private persistEntry(entry: MemoryEntry): void {
    if (!this.storeDir) return;
    // Synchronous append. Safe against other sync appends on the same file
    // (they block each other). The only race was persistAll vs persistAll,
    // which is locked. persistEntry vs persistAll is still a race, but
    // persistAll rewrites the whole file — to fix that we'd need a reader-writer
    // lock. For now, persistEntry stays sync so tests work correctly.
    const filename = entry.tier === "episodic" ? "episodic.jsonl" : "semantic.jsonl";
    const filePath = join(this.storeDir!, filename);
    writeFileSync(filePath, JSON.stringify(entry) + "\n", { flag: "a" });
  }

  private persistAll(): void {
    if (!this.storeDir) return;
    this._pendingWrites++;
    // Wait for any in-flight write to finish first
    this._writeLock = this._writeLock.then(() => {
      this.writeJsonl("episodic.jsonl", this.episodic);
      this.writeJsonl("semantic.jsonl", this.semantic);
      this._pendingWrites = Math.max(0, this._pendingWrites - 1);
    });
  }

  private loadJsonl<T>(filename: string): T[] {
    if (!this.storeDir) return [];
    const filePath = join(this.storeDir, filename);
    if (!existsSync(filePath)) return [];
    // Clean up any leftover .tmp files from a crash during atomic write
    const tmpPath = filePath + ".tmp";
    if (existsSync(tmpPath)) {
      try {
        const tmpContent = readFileSync(tmpPath, "utf-8").trim();
        if (tmpContent.length > 0) {
          // tmp has data but wasn't renamed — likely a crash between write and rename
          // The main file is still intact, so we can safely discard the tmp
        }
        unlinkSync(tmpPath);
      } catch {
        // Ignore cleanup errors
      }
    }
    try {
      const raw = readFileSync(filePath, "utf-8");
      const lines = raw.trim().split("\n").filter(Boolean);
      const entries: T[] = [];
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line) as T;
          // Validate required fields for memory entries
          if (isValidMemoryEntry(parsed)) {
            entries.push(parsed);
          }
          // Otherwise skip silently (malformed entry)
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
    const tmpPath = filePath + ".tmp";
    const content = entries.map((e) => JSON.stringify(e)).join("\n") + (entries.length > 0 ? "\n" : "");
    // Atomic write: write to temp file first, then rename
    // renameSync is atomic on the same filesystem, so a crash mid-write
    // never corrupts the existing data file.
    writeFileSync(tmpPath, content);
    renameSync(tmpPath, filePath);
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
