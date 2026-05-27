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
  /** Number of times this entry has been accessed/retrieved */
  accessCount?: number;
  /** ISO timestamp of last access */
  lastAccessedAt?: string;
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

/** Result of an auto-organize pass (M2). */
export interface MemoryOrganizeResult {
  /** Number of duplicate entries merged */
  duplicatesMerged: number;
  /** Number of expired entries removed */
  expiredRemoved: number;
  /** IDs of entries that were removed */
  removedIds: string[];
}

/** Result of a compression pass (M3). */
export interface MemoryCompressionResult {
  /** Number of entries before compression */
  before: number;
  /** Number of entries after compression */
  after: number;
  /** Number of clusters compressed */
  clustersCompressed: number;
  /** The summary entries created */
  summaries: SemanticEntry[];
}

/** Configuration for memory decay (M4). */
export interface DecayConfig {
  /** Half-life in days — importance halves every this many days without access. Default: 30 */
  halfLifeDays: number;
  /** Minimum importance floor — never decay below this. Default: 0.05 */
  minImportance: number;
  /** Only decay entries older than this many days. Default: 7 */
  minAgeDays: number;
}

export const DEFAULT_DECAY_CONFIG: DecayConfig = {
  halfLifeDays: 30,
  minImportance: 0.05,
  minAgeDays: 7,
};

/** High-value content signals for auto-extraction (M1). */
const HIGH_VALUE_SIGNALS = [
  "error",
  "bug",
  "fix",
  "solution",
  "learned",
  "lesson",
  "important",
  "critical",
  "decision",
  "architecture",
  "pattern",
  "best practice",
  "gotcha",
  "workaround",
  "breakthrough",
  "discovered",
  "insight",
  "key finding",
  "root cause",
  "resolved",
];

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
  if (
    typeof e.id !== "string" ||
    typeof e.tier !== "string" ||
    !["working", "episodic", "semantic"].includes(e.tier as string) ||
    typeof e.content !== "string" ||
    !Array.isArray(e.tags) ||
    typeof e.createdAt !== "string" ||
    typeof e.updatedAt !== "string" ||
    typeof e.importance !== "number"
  ) return false;
  // Optional fields: if present, must be correct type
  if (e.accessCount !== undefined && typeof e.accessCount !== "number") return false;
  if (e.lastAccessedAt !== undefined && typeof e.lastAccessedAt !== "string") return false;
  return true;
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

  // ─── M1: Auto-Extract ────────────────────────────────────────────────────

  /**
   * Analyze content for high-value signals and automatically store as
   * semantic memory if it scores above the threshold.
   *
   * Returns the created entry, or null if content was not deemed high-value.
   */
  autoExtract(
    content: string,
    context: { source?: string; tags?: string[]; threshold?: number } = {},
  ): SemanticEntry | null {
    const threshold = context.threshold ?? 0.3;
    const score = this.scoreContentValue(content);
    if (score < threshold) return null;

    const key = this.extractKey(content);
    const tags = [...(context.tags ?? []), "auto-extracted"];

    return this.addSemantic(key, content, tags, context.source, score);
  }

  /**
   * Batch auto-extract: analyze multiple content strings and store
   * high-value ones. Returns only the entries that were created.
   */
  autoExtractBatch(
    contents: string[],
    context: { source?: string; tags?: string[]; threshold?: number } = {},
  ): SemanticEntry[] {
    const results: SemanticEntry[] = [];
    for (const content of contents) {
      const entry = this.autoExtract(content, context);
      if (entry) results.push(entry);
    }
    return results;
  }

  /**
   * Score content for "high-value" signals. Returns 0-1.
   * Checks for signal keywords, content length, specificity indicators.
   */
  private scoreContentValue(content: string): number {
    const lower = content.toLowerCase();
    let signalHits = 0;

    for (const signal of HIGH_VALUE_SIGNALS) {
      if (lower.includes(signal)) signalHits++;
    }

    // Signal score: up to 0.5 from keyword matches (cap at 3 hits)
    const signalScore = Math.min(signalHits / 6, 0.5);

    // Length score: longer content is likely more detailed (up to 0.2)
    const lengthScore = Math.min(content.length / 500, 0.2);

    // Specificity: contains code paths, numbers, or technical terms (up to 0.3)
    const hasCodePath = /[\/\\][\w.-]+\.(ts|js|py|md|json)/.test(content);
    const hasNumbers = /\d+/.test(content);
    const hasTechnical = /\b(function|class|interface|type|import|export|async|await)\b/.test(content);
    const specificityScore = (hasCodePath ? 0.1 : 0) + (hasNumbers ? 0.1 : 0) + (hasTechnical ? 0.1 : 0);

    return Math.min(signalScore + lengthScore + specificityScore, 1.0);
  }

  /**
   * Extract a concise key from content for semantic memory storage.
   * Takes the first sentence or first 80 chars, whichever is shorter.
   */
  private extractKey(content: string): string {
    const firstSentence = content.match(/^[^.!?\n]+[.!?]/)?.[0];
    const key = firstSentence ?? content.split("\n")[0] ?? content;
    return key.length > 80 ? key.slice(0, 77) + "..." : key.trim();
  }

  // ─── M2: Auto-Organize ───────────────────────────────────────────────────

  /**
   * Run a full organize pass: deduplicate similar entries, merge them,
   * and clean up expired/stale memories.
   *
   * @param options.ttlDays - Remove semantic/episodic entries older than this (0 = disabled)
   * @param options.similarityThreshold - Content similarity threshold for dedup (0-1, default 0.8)
   */
  autoOrganize(options: {
    ttlDays?: number;
    similarityThreshold?: number;
  } = {}): MemoryOrganizeResult {
    const ttlDays = options.ttlDays ?? 0;
    const simThreshold = options.similarityThreshold ?? 0.8;

    let duplicatesMerged = 0;
    let expiredRemoved = 0;
    const removedIds: string[] = [];

    // Step 1: Dedup semantic entries by content similarity
    const semanticPairs = this.findSimilarPairs(this.semantic, simThreshold);
    const toRemove = new Set<string>();

    for (const [a, b] of semanticPairs) {
      if (toRemove.has(a.id) || toRemove.has(b.id)) continue;
      // Keep the one with higher importance, merge tags
      const [keep, remove] = a.importance >= b.importance ? [a, b] : [b, a];
      keep.tags = [...new Set([...keep.tags, ...remove.tags])];
      keep.importance = Math.max(keep.importance, remove.importance);
      keep.updatedAt = now();
      toRemove.add(remove.id);
      removedIds.push(remove.id);
      duplicatesMerged++;
    }

    if (toRemove.size > 0) {
      this.semantic = this.semantic.filter((e) => !toRemove.has(e.id));
      for (const id of toRemove) this.searchIndex.remove(id);
    }

    // Step 2: Dedup episodic entries by taskSummary similarity
    const episodicPairs = this.findSimilarPairs(this.episodic, simThreshold);
    const epiToRemove = new Set<string>();

    for (const [a, b] of episodicPairs) {
      if (epiToRemove.has(a.id) || epiToRemove.has(b.id)) continue;
      const [keep, remove] = a.importance >= b.importance ? [a, b] : [b, a];
      keep.lessons = [...new Set([...keep.lessons, ...remove.lessons])];
      keep.tags = [...new Set([...keep.tags, ...remove.tags])];
      keep.updatedAt = now();
      epiToRemove.add(remove.id);
      removedIds.push(remove.id);
      duplicatesMerged++;
    }

    if (epiToRemove.size > 0) {
      this.episodic = this.episodic.filter((e) => !epiToRemove.has(e.id));
      for (const id of epiToRemove) this.searchIndex.remove(id);
    }

    // Step 3: Remove expired entries (if TTL enabled)
    if (ttlDays > 0) {
      const cutoff = Date.now() - ttlDays * 86400000;
      const cutoffISO = new Date(cutoff).toISOString();

      const beforeSemantic = this.semantic.length;
      const expiredSemanticIds = this.semantic
        .filter((e) => e.updatedAt < cutoffISO)
        .map((e) => e.id);
      this.semantic = this.semantic.filter((e) => e.updatedAt >= cutoffISO);
      for (const id of expiredSemanticIds) {
        this.searchIndex.remove(id);
        removedIds.push(id);
      }
      expiredRemoved += beforeSemantic - this.semantic.length;

      const beforeEpisodic = this.episodic.length;
      const expiredEpisodicIds = this.episodic
        .filter((e) => e.updatedAt < cutoffISO)
        .map((e) => e.id);
      this.episodic = this.episodic.filter((e) => e.updatedAt >= cutoffISO);
      for (const id of expiredEpisodicIds) {
        this.searchIndex.remove(id);
        removedIds.push(id);
      }
      expiredRemoved += beforeEpisodic - this.episodic.length;
    }

    // Persist changes
    if (duplicatesMerged > 0 || expiredRemoved > 0) {
      this.persistAll();
    }

    return { duplicatesMerged, expiredRemoved, removedIds };
  }

  /**
   * Find pairs of entries with content similarity above the threshold.
   * Uses trigram Jaccard similarity for efficiency.
   */
  private findSimilarPairs<T extends MemoryEntry>(
    entries: T[],
    threshold: number,
  ): [T, T][] {
    const pairs: [T, T][] = [];
    const trigramCache = new Map<string, Set<string>>();

    const getTrigrams = (text: string): Set<string> => {
      const cached = trigramCache.get(text);
      if (cached) return cached;
      const lower = text.toLowerCase();
      const trigrams = new Set<string>();
      for (let i = 0; i <= lower.length - 3; i++) {
        trigrams.add(lower.slice(i, i + 3));
      }
      trigramCache.set(text, trigrams);
      return trigrams;
    };

    const jaccard = (a: Set<string>, b: Set<string>): number => {
      if (a.size === 0 && b.size === 0) return 1;
      let intersection = 0;
      for (const t of a) { if (b.has(t)) intersection++; }
      const union = a.size + b.size - intersection;
      return union > 0 ? intersection / union : 0;
    };

    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        const aTri = getTrigrams(entries[i]!.content);
        const bTri = getTrigrams(entries[j]!.content);
        if (jaccard(aTri, bTri) >= threshold) {
          pairs.push([entries[i]!, entries[j]!]);
        }
      }
    }

    return pairs;
  }

  // ─── M3: Memory Compression ──────────────────────────────────────────────

  /**
   * Cluster similar memories by tag overlap and compress each cluster
   * into a single summary entry. Keeps the most important entry in each
   * cluster as the base, merges content from others.
   *
   * @param options.minClusterSize - Minimum entries to form a cluster (default: 3)
   * @param options.maxClusters - Maximum clusters to compress in one pass (default: 10)
   */
  compressMemories(options: {
    minClusterSize?: number;
    maxClusters?: number;
  } = {}): MemoryCompressionResult {
    const minClusterSize = options.minClusterSize ?? 3;
    const maxClusters = options.maxClusters ?? 10;

    const allEntries = [...this.semantic, ...this.episodic];
    const before = allEntries.length;

    // Build clusters by tag overlap
    const clusters = this.clusterByTags(allEntries, minClusterSize);

    let clustersCompressed = 0;
    const summaries: SemanticEntry[] = [];
    const removedIds = new Set<string>();

    for (const cluster of clusters) {
      if (clustersCompressed >= maxClusters) break;
      if (cluster.length < minClusterSize) continue;

      // Sort by importance descending — keep the top entry as base
      cluster.sort((a, b) => b.importance - a.importance);
      const base = cluster[0]!;
      const others = cluster.slice(1);

      // Build a summary from all entries in the cluster
      const allContent = cluster.map((e) => e.content).join("\n---\n");
      const allTags = [...new Set(cluster.flatMap((e) => e.tags))];
      const avgImportance = cluster.reduce((s, e) => s + e.importance, 0) / cluster.length;

      // Create a compressed summary entry
      const summaryKey = `summary: ${base.content.slice(0, 60)}${base.content.length > 60 ? "..." : ""}`;
      const summaryValue = `[Compressed from ${cluster.length} memories]\n\n${allContent}`;

      const summary = this.addSemantic(
        summaryKey,
        summaryValue,
        [...allTags, "compressed"],
        "memory-compression",
        Math.max(avgImportance, 0.3),
      );
      summaries.push(summary);

      // Mark originals for removal (except the summary we just added)
      for (const entry of others) {
        removedIds.add(entry.id);
      }
      // Also remove the base entry since it's now in the summary
      removedIds.add(base.id);

      clustersCompressed++;
    }

    // Remove compressed originals
    if (removedIds.size > 0) {
      this.semantic = this.semantic.filter((e) => !removedIds.has(e.id));
      this.episodic = this.episodic.filter((e) => !removedIds.has(e.id));
      for (const id of removedIds) this.searchIndex.remove(id);
      this.persistAll();
    }

    return {
      before,
      after: this.semantic.length + this.episodic.length,
      clustersCompressed,
      summaries,
    };
  }

  /**
   * Cluster entries by tag overlap using union-find.
   * Two entries are in the same cluster if they share at least one tag
   * and the cluster meets the minimum size requirement.
   */
  private clusterByTags(entries: MemoryEntry[], _minSize: number): MemoryEntry[][] {
    if (entries.length === 0) return [];

    // Build tag → entry indices
    const tagToIndices = new Map<string, number[]>();
    for (let i = 0; i < entries.length; i++) {
      for (const tag of entries[i]!.tags) {
        if (!tagToIndices.has(tag)) tagToIndices.set(tag, []);
        tagToIndices.get(tag)!.push(i);
      }
    }

    // Union-find
    const parent = entries.map((_, i) => i);
    const find = (x: number): number => { while (parent[x] !== x) { parent[x] = parent[parent[x]!]!; x = parent[x]!; } return x; };
    const union = (a: number, b: number): void => { parent[find(a)] = find(b); };

    for (const indices of tagToIndices.values()) {
      for (let i = 1; i < indices.length; i++) {
        union(indices[0]!, indices[i]!);
      }
    }

    // Group by root
    const clusters = new Map<number, MemoryEntry[]>();
    for (let i = 0; i < entries.length; i++) {
      const root = find(i);
      if (!clusters.has(root)) clusters.set(root, []);
      clusters.get(root)!.push(entries[i]!);
    }

    return [...clusters.values()];
  }

  // ─── M4: Memory Decay ────────────────────────────────────────────────────

  /**
   * Record an access to a memory entry. Updates accessCount and
   * lastAccessedAt. Call this when a memory is retrieved via search.
   */
  recordAccess(entryId: string): void {
    const entry = this.findEntryById(entryId);
    if (!entry) return;
    entry.accessCount = (entry.accessCount ?? 0) + 1;
    entry.lastAccessedAt = now();
  }

  /**
   * Apply exponential decay to importance scores of all persisted entries.
   * Uses the formula: newImportance = baseImportance * 2^(-ageDays / halfLife)
   *
   * Entries with recent access get a "refresh" that slows their decay.
   * Returns the number of entries whose importance was updated.
   */
  decayImportance(config: DecayConfig = DEFAULT_DECAY_CONFIG): number {
    const nowMs = Date.now();
    const minAgeMs = config.minAgeDays * 86400000;
    let updated = 0;

    const decayEntry = (entry: MemoryEntry): void => {
      const createdMs = new Date(entry.createdAt).getTime();
      const ageMs = nowMs - createdMs;
      if (ageMs < minAgeMs) return;

      const lastAccess = entry.lastAccessedAt
        ? new Date(entry.lastAccessedAt).getTime()
        : createdMs;
      const daysSinceAccess = (nowMs - lastAccess) / 86400000;

      // Exponential decay based on days since last access
      const decayFactor = Math.pow(2, -daysSinceAccess / config.halfLifeDays);
      const newImportance = Math.max(
        entry.importance * decayFactor,
        config.minImportance,
      );

      // Only update if meaningfully different (avoid micro-churn)
      if (Math.abs(newImportance - entry.importance) > 0.001) {
        entry.importance = newImportance;
        entry.updatedAt = now();
        updated++;
      }
    };

    for (const entry of this.episodic) decayEntry(entry);
    for (const entry of this.semantic) decayEntry(entry);

    // Update the inverted index entries
    for (const entry of [...this.episodic, ...this.semantic]) {
      this.searchIndex.remove(entry.id);
      this.searchIndex.add(entry);
    }

    if (updated > 0) this.persistAll();
    return updated;
  }

  /**
   * Get entries whose importance has decayed below the given threshold.
   * Useful for cleanup: remove entries that are no longer relevant.
   */
  getDecayedEntries(threshold: number = 0.1): MemoryEntry[] {
    const allEntries: MemoryEntry[] = [...this.episodic, ...this.semantic];
    return allEntries.filter((e) => e.importance < threshold);
  }

  /**
   * Find an entry by ID across all tiers.
   */
  private findEntryById(id: string): MemoryEntry | undefined {
    return (
      this.working.find((e) => e.id === id) ??
      this.episodic.find((e) => e.id === id) ??
      this.semantic.find((e) => e.id === id)
    );
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
