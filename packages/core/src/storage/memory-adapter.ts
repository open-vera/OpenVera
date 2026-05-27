/**
 * Memory Storage Adapter — SQLite-backed memory with FTS5 full-text search.
 *
 * Wraps SqliteStorageProvider to persist all memory tiers (working, episodic,
 * semantic) with fast full-text search via FTS5 and an in-memory inverted
 * index for backward compatibility with the existing MemoryStore API.
 */

import type { SqliteStorageProvider } from "./sqlite.js";
import type {
  StoredMemory,
  StorageOptions,
} from "./types.js";
import { StorageBackendError } from "./types.js";

// ── Types ────────────────────────────────────────────────────────────────────

export type MemoryTier = "working" | "episodic" | "semantic";

export interface MemoryEntry {
  id: string;
  tier: MemoryTier;
  content: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  source?: string;
  importance: number;
  accessCount?: number;
  lastAccessedAt?: string;
  /** Episodic-specific */
  taskSummary?: string;
  outcome?: string;
  lessons?: string[];
  /** Semantic-specific */
  key?: string;
  value?: string;
}

export interface EpisodicEntry extends MemoryEntry {
  tier: "episodic";
  taskSummary: string;
  outcome: string;
  lessons: string[];
}

export interface SemanticEntry extends MemoryEntry {
  tier: "semantic";
  key: string;
  value: string;
}

export interface MemoryAdapterOptions {
  /** SQLite database file path */
  dbPath: string;
  /** Max working memory entries before auto-eviction. Default: 200 */
  maxWorkingEntries?: number;
  /** Max entries in the inverted index. Default: 5000 */
  maxIndexEntries?: number;
  /** Working memory TTL in seconds (0 = no auto-expiry). Default: 0 */
  workingTtlSeconds?: number;
  /** Enable WAL mode. Default: true */
  walMode?: boolean;
}

export interface MemorySearchResult {
  entry: MemoryEntry;
  score: number;
  matchedTerms: string[];
}

export interface MemoryOrganizeResult {
  duplicatesMerged: number;
  expiredRemoved: number;
  removedIds: string[];
}

export interface MemoryCompressionResult {
  before: number;
  after: number;
  clustersCompressed: number;
  summaries: SemanticEntry[];
}

export interface DecayConfig {
  halfLifeDays: number;
  minImportance: number;
  minAgeDays: number;
}

export const DEFAULT_DECAY_CONFIG: DecayConfig = {
  halfLifeDays: 30,
  minImportance: 0.05,
  minAgeDays: 7,
};

// ── Constants ────────────────────────────────────────────────────────────────

const MEMORY_NS = "memory";
const SEARCH_NS = "memory_search";

const HIGH_VALUE_SIGNALS = [
  "error", "bug", "fix", "solution", "learned", "lesson",
  "important", "critical", "decision", "architecture", "pattern",
  "best practice", "gotcha", "workaround", "breakthrough",
  "discovered", "insight", "key finding", "root cause", "resolved",
];

// ── Helpers ──────────────────────────────────────────────────────────────────

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
    .replace(/[^a-z0-9一-鿿]+/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1);
}

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

function makeSearchableText(entry: MemoryEntry): string {
  const parts = [entry.content, ...entry.tags];
  if (entry.taskSummary) parts.push(entry.taskSummary);
  if (entry.outcome) parts.push(entry.outcome);
  if (entry.lessons) parts.push(entry.lessons.join(" "));
  if (entry.key) parts.push(entry.key);
  if (entry.value) parts.push(entry.value);
  return parts.join(" ");
}

// ── Inverted Index ───────────────────────────────────────────────────────────

class InvertedIndex {
  private index = new Map<string, Set<string>>();
  private reverseIndex = new Map<string, Set<string>>();
  private entryStore = new Map<string, MemoryEntry>();
  private insertionOrder: string[] = [];

  constructor(private readonly maxEntries: number = 5000) {}

  add(entry: MemoryEntry): void {
    const terms = tokenize(entry.content + " " + entry.tags.join(" "));

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

  getEntry(id: string): MemoryEntry | undefined {
    return this.entryStore.get(id);
  }

  get size(): number {
    return this.entryStore.size;
  }

  clear(): void {
    this.index.clear();
    this.reverseIndex.clear();
    this.entryStore.clear();
    this.insertionOrder = [];
  }
}

// ── Memory Storage Adapter ───────────────────────────────────────────────────

export class MemoryStorageAdapter {
  private entryProvider!: SqliteStorageProvider;
  private searchProvider!: SqliteStorageProvider;
  private searchIndex: InvertedIndex;
  private readonly maxWorking: number;
  private readonly workingTtl: number;
  private initialized = false;
  private closed = false;

  private readonly dbPath: string;
  private readonly walMode: boolean;

  constructor(private readonly options: MemoryAdapterOptions) {
    this.dbPath = options.dbPath;
    this.walMode = options.walMode ?? true;
    this.maxWorking = options.maxWorkingEntries ?? 200;
    this.workingTtl = options.workingTtlSeconds ?? 0;
    this.searchIndex = new InvertedIndex(options.maxIndexEntries ?? 5000);
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    const { SqliteStorageProvider } = await import("./sqlite.js");

    // Main store for full memory entries (JSON values, no FTS needed)
    const entryOpts: StorageOptions = {
      backend: "sqlite",
      dbPath: this.dbPath,
      walMode: this.walMode,
      enableFts: false,
    };
    this.entryProvider = new SqliteStorageProvider(entryOpts);
    await this.entryProvider.initialize();

    // Separate FTS5-enabled store for searchable text
    const searchOpts: StorageOptions = {
      backend: "sqlite",
      dbPath: this.dbPath + ".fts",
      walMode: this.walMode,
      enableFts: true,
    };
    this.searchProvider = new SqliteStorageProvider(searchOpts);
    await this.searchProvider.initialize();

    // Rebuild inverted index from persisted data
    await this.rebuildIndex();

    this.initialized = true;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.searchIndex.clear();
    await this.entryProvider.close();
    await this.searchProvider.close();
  }

  isHealthy(): boolean {
    return !this.closed && this.initialized;
  }

  // ── Working Memory ───────────────────────────────────────────────────────

  async addWorking(
    content: string,
    tags: string[] = [],
    source?: string,
    importance = 0.5,
  ): Promise<MemoryEntry> {
    this.ensureReady();
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
    await this.storeEntry(entry);
    return entry;
  }

  async getWorking(): Promise<MemoryEntry[]> {
    return this.getByTier("working");
  }

  async clearWorking(): Promise<void> {
    this.ensureReady();
    const entries = await this.getWorking();
    for (const entry of entries) {
      await this.removeEntry(entry.id);
    }
  }

  // ── Episodic Memory ──────────────────────────────────────────────────────

  async addEpisodic(
    taskSummary: string,
    outcome: string,
    lessons: string[],
    tags: string[] = [],
    source?: string,
    importance = 0.7,
  ): Promise<EpisodicEntry> {
    this.ensureReady();
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
    await this.storeEntry(entry);
    return entry;
  }

  async getEpisodic(): Promise<EpisodicEntry[]> {
    return (await this.getByTier("episodic")) as EpisodicEntry[];
  }

  // ── Semantic Memory ──────────────────────────────────────────────────────

  async addSemantic(
    key: string,
    value: string,
    tags: string[] = [],
    source?: string,
    importance = 0.8,
  ): Promise<SemanticEntry> {
    this.ensureReady();

    // Deduplicate by key
    const existing = await this.findSemanticByKey(key);
    if (existing) {
      const updated: SemanticEntry = {
        ...existing,
        value,
        tags: [...new Set([...existing.tags, ...tags])],
        updatedAt: now(),
        importance: Math.max(existing.importance, importance),
      };
      await this.storeEntry(updated);
      return updated;
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
    await this.storeEntry(entry);
    return entry;
  }

  async getSemantic(): Promise<SemanticEntry[]> {
    return (await this.getByTier("semantic")) as SemanticEntry[];
  }

  async removeSemantic(key: string): Promise<boolean> {
    this.ensureReady();
    const existing = await this.findSemanticByKey(key);
    if (!existing) return false;
    await this.removeEntry(existing.id);
    return true;
  }

  // ── Search ───────────────────────────────────────────────────────────────

  async search(
    query: string,
    options: { tiers?: MemoryTier[]; limit?: number; useFts?: boolean } = {},
  ): Promise<MemorySearchResult[]> {
    this.ensureReady();
    const tiers = options.tiers ?? ["working", "episodic", "semantic"];
    const limit = options.limit ?? 10;
    const useFts = options.useFts ?? true;
    const queryTerms = extractKeywords(query);
    if (queryTerms.length === 0) return [];

    const tierSet = new Set(tiers);

    if (useFts) {
      // Try FTS5 search first
      const ftsResults = await this.ftsSearch(query, tierSet, limit * 2);
      if (ftsResults.length > 0) {
        return ftsResults.slice(0, limit);
      }
    }

    // Fallback to inverted index search
    return this.indexSearch(queryTerms, tierSet, limit);
  }

  private async ftsSearch(
    query: string,
    tierSet: Set<MemoryTier>,
    limit: number,
  ): Promise<MemorySearchResult[]> {
    try {
      const ftsQuery = this.buildFtsQuery(query);
      if (!ftsQuery) return [];

      const result = await this.searchProvider.query(SEARCH_NS, {
        fullTextSearch: ftsQuery,
        limit,
      });

      const results: MemorySearchResult[] = [];
      for (const { key } of result.entries) {
        const entry = await this.getEntryById(key);
        if (!entry || !tierSet.has(entry.tier)) continue;

        // Track access
        await this.recordAccess(entry.id);

        const queryTerms = extractKeywords(query);
        const entryTerms = tokenize(entry.content + " " + entry.tags.join(" "));
        const entryTermSet = new Set(entryTerms);
        const matchedTerms = queryTerms.filter((t) => entryTermSet.has(t));
        const baseScore = matchedTerms.length / Math.min(queryTerms.length, matchedTerms.length || 1);
        const score = baseScore * 0.7 + entry.importance * 0.3;

        results.push({ entry, score, matchedTerms });
      }

      results.sort((a, b) => b.score - a.score);
      return results;
    } catch {
      // FTS query might fail on special characters; fall back to index
      return [];
    }
  }

  private indexSearch(
    queryTerms: string[],
    tierSet: Set<MemoryTier>,
    limit: number,
  ): Promise<MemorySearchResult[]> {
    const matchCounts = this.searchIndex.search(queryTerms);
    const results: MemorySearchResult[] = [];

    for (const [entryId, matchedCount] of matchCounts) {
      const entry = this.searchIndex.getEntry(entryId);
      if (!entry || !tierSet.has(entry.tier)) continue;

      const denominator = Math.min(queryTerms.length, matchedCount);
      const baseScore = denominator > 0 ? matchedCount / denominator : 0;
      if (baseScore === 0) continue;

      const adjustedScore = baseScore * 0.7 + entry.importance * 0.3;

      const entryTerms = tokenize(entry.content + " " + entry.tags.join(" "));
      const entryTermSet = new Set(entryTerms);
      const matchedTerms = queryTerms.filter((t) => entryTermSet.has(t));

      results.push({ entry, score: adjustedScore, matchedTerms });
    }

    results.sort((a, b) => b.score - a.score);
    return Promise.resolve(results.slice(0, limit));
  }

  private buildFtsQuery(query: string): string | null {
    // Escape special FTS5 characters and build a phrase/AND query
    const terms = tokenize(query);
    if (terms.length === 0) return null;
    // Use OR semantics so any matching term returns results
    return terms.map((t) => `"${t}"`).join(" OR ");
  }

  // ── Stats ────────────────────────────────────────────────────────────────

  async stats(): Promise<{
    working: number;
    episodic: number;
    semantic: number;
    total: number;
    indexSize: number;
  }> {
    this.ensureReady();
    const all = await this.listAllEntries();
    let working = 0;
    let episodic = 0;
    let semantic = 0;
    for (const entry of all) {
      if (entry.tier === "working") working++;
      else if (entry.tier === "episodic") episodic++;
      else if (entry.tier === "semantic") semantic++;
    }
    return {
      working,
      episodic,
      semantic,
      total: all.length,
      indexSize: this.searchIndex.size,
    };
  }

  // ── M1: Auto-Extract ─────────────────────────────────────────────────────

  async autoExtract(
    content: string,
    context: { source?: string; tags?: string[]; threshold?: number } = {},
  ): Promise<SemanticEntry | null> {
    const threshold = context.threshold ?? 0.3;
    const score = this.scoreContentValue(content);
    if (score < threshold) return null;

    const key = this.extractKey(content);
    const tags = [...(context.tags ?? []), "auto-extracted"];
    return this.addSemantic(key, content, tags, context.source, score);
  }

  async autoExtractBatch(
    contents: string[],
    context: { source?: string; tags?: string[]; threshold?: number } = {},
  ): Promise<SemanticEntry[]> {
    const results: SemanticEntry[] = [];
    for (const content of contents) {
      const entry = await this.autoExtract(content, context);
      if (entry) results.push(entry);
    }
    return results;
  }

  private scoreContentValue(content: string): number {
    const lower = content.toLowerCase();
    let signalHits = 0;
    for (const signal of HIGH_VALUE_SIGNALS) {
      if (lower.includes(signal)) signalHits++;
    }
    const signalScore = Math.min(signalHits / 6, 0.5);
    const lengthScore = Math.min(content.length / 500, 0.2);
    const hasCodePath = /[\/\\][\w.-]+\.(ts|js|py|md|json)/.test(content);
    const hasNumbers = /\d+/.test(content);
    const hasTechnical = /\b(function|class|interface|type|import|export|async|await)\b/.test(content);
    const specificityScore = (hasCodePath ? 0.1 : 0) + (hasNumbers ? 0.1 : 0) + (hasTechnical ? 0.1 : 0);
    return Math.min(signalScore + lengthScore + specificityScore, 1.0);
  }

  private extractKey(content: string): string {
    const firstSentence = content.match(/^[^.!?\n]+[.!?]/)?.[0];
    const key = firstSentence ?? content.split("\n")[0] ?? content;
    return key.length > 80 ? key.slice(0, 77) + "..." : key.trim();
  }

  // ── M2: Auto-Organize ────────────────────────────────────────────────────

  async autoOrganize(
    options: { ttlDays?: number; similarityThreshold?: number } = {},
  ): Promise<MemoryOrganizeResult> {
    this.ensureReady();
    const ttlDays = options.ttlDays ?? 0;
    const simThreshold = options.similarityThreshold ?? 0.8;

    let duplicatesMerged = 0;
    let expiredRemoved = 0;
    const removedIds: string[] = [];

    // Dedup semantic entries
    const semantic = await this.getSemantic();
    const semanticPairs = this.findSimilarPairs(semantic, simThreshold);
    const toRemove = new Set<string>();

    for (const [a, b] of semanticPairs) {
      if (toRemove.has(a.id) || toRemove.has(b.id)) continue;
      const [keep, remove] = a.importance >= b.importance ? [a, b] : [b, a];
      keep.tags = [...new Set([...keep.tags, ...remove.tags])];
      keep.importance = Math.max(keep.importance, remove.importance);
      keep.updatedAt = now();
      toRemove.add(remove.id);
      removedIds.push(remove.id);
      duplicatesMerged++;
    }

    // Apply kept entry updates and remove duplicates
    for (const [a, b] of semanticPairs) {
      if (toRemove.has(a.id) || toRemove.has(b.id)) continue;
      const keep = a.importance >= b.importance ? a : b;
      await this.storeEntry(keep);
    }
    for (const id of toRemove) {
      await this.removeEntry(id);
    }

    // Dedup episodic entries
    const episodic = await this.getEpisodic();
    const episodicPairs = this.findSimilarPairs(episodic, simThreshold);
    const epiToRemove = new Set<string>();

    for (const [a, b] of episodicPairs) {
      if (epiToRemove.has(a.id) || epiToRemove.has(b.id)) continue;
      const [keep, remove] = a.importance >= b.importance ? [a, b] : [b, a];
      if ("lessons" in keep && "lessons" in remove) {
        (keep as EpisodicEntry).lessons = [
          ...new Set([...(keep as EpisodicEntry).lessons, ...(remove as EpisodicEntry).lessons]),
        ];
      }
      keep.tags = [...new Set([...keep.tags, ...remove.tags])];
      keep.updatedAt = now();
      epiToRemove.add(remove.id);
      removedIds.push(remove.id);
      duplicatesMerged++;
    }

    for (const id of epiToRemove) {
      await this.removeEntry(id);
    }

    // Remove expired entries (if TTL enabled)
    if (ttlDays > 0) {
      const cutoff = Date.now() - ttlDays * 86400000;
      const cutoffISO = new Date(cutoff).toISOString();
      const all = await this.listAllEntries();
      for (const entry of all) {
        if (entry.tier === "working") continue;
        if (entry.updatedAt < cutoffISO) {
          await this.removeEntry(entry.id);
          removedIds.push(entry.id);
          expiredRemoved++;
        }
      }
    }

    return { duplicatesMerged, expiredRemoved, removedIds };
  }

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
      for (const t of a) {
        if (b.has(t)) intersection++;
      }
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

  // ── M3: Memory Compression ───────────────────────────────────────────────

  async compressMemories(
    options: { minClusterSize?: number; maxClusters?: number } = {},
  ): Promise<MemoryCompressionResult> {
    this.ensureReady();
    const minClusterSize = options.minClusterSize ?? 3;
    const maxClusters = options.maxClusters ?? 10;

    const allEntries = await this.listAllEntries();
    const persistent = allEntries.filter((e) => e.tier !== "working");
    const before = persistent.length;

    const clusters = this.clusterByTags(persistent, minClusterSize);

    let clustersCompressed = 0;
    const summaries: SemanticEntry[] = [];
    const removedIds = new Set<string>();

    for (const cluster of clusters) {
      if (clustersCompressed >= maxClusters) break;
      if (cluster.length < minClusterSize) continue;

      cluster.sort((a, b) => b.importance - a.importance);
      const base = cluster[0]!;

      const allContent = cluster.map((e) => e.content).join("\n---\n");
      const allTags = [...new Set(cluster.flatMap((e) => e.tags))];
      const avgImportance =
        cluster.reduce((s, e) => s + e.importance, 0) / cluster.length;

      const summaryKey = `summary: ${base.content.slice(0, 60)}${base.content.length > 60 ? "..." : ""}`;
      const summaryValue = `[Compressed from ${cluster.length} memories]\n\n${allContent}`;

      const summary = await this.addSemantic(
        summaryKey,
        summaryValue,
        [...allTags, "compressed"],
        "memory-compression",
        Math.max(avgImportance, 0.3),
      );
      summaries.push(summary);

      for (const entry of cluster) {
        removedIds.add(entry.id);
      }
      clustersCompressed++;
    }

    if (removedIds.size > 0) {
      for (const id of removedIds) {
        await this.removeEntry(id);
      }
    }

    const afterStats = await this.stats();
    return {
      before,
      after: afterStats.episodic + afterStats.semantic,
      clustersCompressed,
      summaries,
    };
  }

  private clusterByTags(entries: MemoryEntry[], _minSize: number): MemoryEntry[][] {
    if (entries.length === 0) return [];

    const tagToIndices = new Map<string, number[]>();
    for (let i = 0; i < entries.length; i++) {
      for (const tag of entries[i]!.tags) {
        if (!tagToIndices.has(tag)) tagToIndices.set(tag, []);
        tagToIndices.get(tag)!.push(i);
      }
    }

    const parent = entries.map((_, i) => i);
    const find = (x: number): number => {
      while (parent[x] !== x) {
        parent[x] = parent[parent[x]!]!;
        x = parent[x]!;
      }
      return x;
    };
    const union = (a: number, b: number): void => {
      parent[find(a)] = find(b);
    };

    for (const indices of tagToIndices.values()) {
      for (let i = 1; i < indices.length; i++) {
        union(indices[0]!, indices[i]!);
      }
    }

    const clusters = new Map<number, MemoryEntry[]>();
    for (let i = 0; i < entries.length; i++) {
      const root = find(i);
      if (!clusters.has(root)) clusters.set(root, []);
      clusters.get(root)!.push(entries[i]!);
    }

    return [...clusters.values()];
  }

  // ── M4: Memory Decay ─────────────────────────────────────────────────────

  async recordAccess(entryId: string): Promise<void> {
    this.ensureReady();
    const raw = await this.entryProvider.get(MEMORY_NS, entryId);
    if (!raw) return;

    const entry = raw as unknown as MemoryEntry;
    entry.accessCount = (entry.accessCount ?? 0) + 1;
    entry.lastAccessedAt = now();

    await this.entryProvider.set(MEMORY_NS, entryId, entry as unknown as import("./types.js").StorageValue);
    // Update inverted index
    this.searchIndex.remove(entryId);
    this.searchIndex.add(entry);
  }

  async decayImportance(config: DecayConfig = DEFAULT_DECAY_CONFIG): Promise<number> {
    this.ensureReady();
    const nowMs = Date.now();
    const minAgeMs = config.minAgeDays * 86400000;
    let updated = 0;

    const all = await this.listAllEntries();
    for (const entry of all) {
      if (entry.tier === "working") continue;

      const createdMs = new Date(entry.createdAt).getTime();
      const ageMs = nowMs - createdMs;
      if (ageMs < minAgeMs) continue;

      const lastAccess = entry.lastAccessedAt
        ? new Date(entry.lastAccessedAt).getTime()
        : createdMs;
      const daysSinceAccess = (nowMs - lastAccess) / 86400000;

      const decayFactor = Math.pow(2, -daysSinceAccess / config.halfLifeDays);
      const newImportance = Math.max(
        entry.importance * decayFactor,
        config.minImportance,
      );

      if (Math.abs(newImportance - entry.importance) > 0.001) {
        entry.importance = newImportance;
        entry.updatedAt = now();
        await this.storeEntry(entry);
        updated++;
      }
    }

    return updated;
  }

  async getDecayedEntries(threshold = 0.1): Promise<MemoryEntry[]> {
    this.ensureReady();
    const all = await this.listAllEntries();
    return all.filter((e) => e.tier !== "working" && e.importance < threshold);
  }

  // ── Persistence Helpers ──────────────────────────────────────────────────

  private async storeEntry(entry: MemoryEntry): Promise<void> {
    const ttl = entry.tier === "working" && this.workingTtl > 0
      ? this.workingTtl
      : undefined;

    await this.entryProvider.set(MEMORY_NS, entry.id, entry as unknown as import("./types.js").StorageValue);

    // Update FTS5 search index
    const searchableText = makeSearchableText(entry);
    await this.searchProvider.set(SEARCH_NS, entry.id, searchableText);

    // Update inverted index
    this.searchIndex.remove(entry.id);
    this.searchIndex.add(entry);
  }

  private async removeEntry(id: string): Promise<void> {
    await this.entryProvider.delete(MEMORY_NS, id);
    await this.searchProvider.delete(SEARCH_NS, id);
    this.searchIndex.remove(id);
  }

  private async getEntryById(id: string): Promise<MemoryEntry | undefined> {
    // Check inverted index first (faster)
    const indexed = this.searchIndex.getEntry(id);
    if (indexed) return indexed;

    const raw = await this.entryProvider.get(MEMORY_NS, id);
    if (!raw) return undefined;
    return raw as unknown as MemoryEntry;
  }

  private async getByTier(tier: MemoryTier): Promise<MemoryEntry[]> {
    const keys = await this.entryProvider.listKeys(MEMORY_NS);
    const results: MemoryEntry[] = [];
    for (const key of keys) {
      const raw = await this.entryProvider.get(MEMORY_NS, key);
      if (!raw) continue;
      const entry = raw as unknown as MemoryEntry;
      if (entry.tier === tier) {
        results.push(entry);
      }
    }
    return results;
  }

  private async listAllEntries(): Promise<MemoryEntry[]> {
    const keys = await this.entryProvider.listKeys(MEMORY_NS);
    const results: MemoryEntry[] = [];
    for (const key of keys) {
      const raw = await this.entryProvider.get(MEMORY_NS, key);
      if (!raw) continue;
      results.push(raw as unknown as MemoryEntry);
    }
    return results;
  }

  private async findSemanticByKey(key: string): Promise<SemanticEntry | undefined> {
    const all = await this.getByTier("semantic");
    return (all as SemanticEntry[]).find((e) => e.key === key);
  }

  private async rebuildIndex(): Promise<void> {
    this.searchIndex.clear();
    const all = await this.listAllEntries();
    for (const entry of all) {
      this.searchIndex.add(entry);
    }
  }

  private ensureReady(): void {
    if (!this.initialized || this.closed) {
      throw new StorageBackendError(
        "memory-adapter",
        "MemoryStorageAdapter not initialized or already closed",
      );
    }
  }
}

// ── Factory ──────────────────────────────────────────────────────────────────

export async function createMemoryAdapter(
  options: MemoryAdapterOptions,
): Promise<MemoryStorageAdapter> {
  const adapter = new MemoryStorageAdapter(options);
  await adapter.initialize();
  return adapter;
}

export { extractKeywords, tokenize };
