/**
 * Memory Relationship Graph (M5)
 *
 * Builds and maintains associations between memory entries based on
 * shared keywords, tags, and co-occurrence. Supports linked retrieval:
 * given a memory, find related memories via graph traversal.
 */

import type { MemoryEntry, MemoryTier } from "./store.js";
import { extractKeywords, tokenize } from "./store.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface MemoryRelation {
  /** ID of the related entry */
  targetId: string;
  /** Strength of the relationship (0-1) */
  strength: number;
  /** Why they're related: shared keywords, tags, or co-occurrence */
  reason: "keyword" | "tag" | "co-occurrence" | "explicit";
}

export interface GraphNode {
  entryId: string;
  tier: MemoryTier;
  /** Outgoing relations */
  relations: MemoryRelation[];
  /** Keywords extracted from this entry's content + tags */
  keywords: string[];
}

export interface RelatedMemory {
  entry: MemoryEntry;
  /** How this entry relates to the query entry */
  relation: MemoryRelation;
  /** Transitive distance from query (1 = direct, 2 = 2 hops, etc.) */
  distance: number;
}

export interface GraphBuildOptions {
  /** Minimum keyword overlap to create a relation. Default: 2 */
  minKeywordOverlap?: number;
  /** Minimum tag overlap to create a relation. Default: 1 */
  minTagOverlap?: number;
  /** Weight for keyword-based relations. Default: 0.5 */
  keywordWeight?: number;
  /** Weight for tag-based relations. Default: 0.3 */
  tagWeight?: number;
  /** Weight for co-occurrence (entries created near the same time). Default: 0.2 */
  coOccurrenceWeight?: number;
  /** Time window in ms for co-occurrence detection. Default: 3600000 (1 hour) */
  coOccurrenceWindowMs?: number;
}

const DEFAULT_BUILD_OPTIONS: Required<GraphBuildOptions> = {
  minKeywordOverlap: 2,
  minTagOverlap: 1,
  keywordWeight: 0.5,
  tagWeight: 0.3,
  coOccurrenceWeight: 0.2,
  coOccurrenceWindowMs: 3600000,
};

// ─── MemoryGraph ─────────────────────────────────────────────────────────────

export class MemoryGraph {
  private nodes = new Map<string, GraphNode>();
  private entryStore = new Map<string, MemoryEntry>();
  private options: Required<GraphBuildOptions>;

  constructor(options: GraphBuildOptions = {}) {
    this.options = { ...DEFAULT_BUILD_OPTIONS, ...options };
  }

  /**
   * Build the graph from a list of memory entries.
   * Clears any existing graph state first.
   */
  build(entries: MemoryEntry[]): void {
    this.nodes.clear();
    this.entryStore.clear();

    // Phase 1: Create nodes
    for (const entry of entries) {
      const keywords = extractKeywords(entry.content + " " + entry.tags.join(" "));
      this.nodes.set(entry.id, {
        entryId: entry.id,
        tier: entry.tier,
        relations: [],
        keywords,
      });
      this.entryStore.set(entry.id, entry);
    }

    // Phase 2: Build relations
    const entryArr = [...entries];
    for (let i = 0; i < entryArr.length; i++) {
      for (let j = i + 1; j < entryArr.length; j++) {
        const a = entryArr[i]!;
        const b = entryArr[j]!;
        const relation = this.computeRelation(a, b);
        if (relation) {
          this.nodes.get(a.id)!.relations.push({ ...relation, targetId: b.id });
          this.nodes.get(b.id)!.relations.push({
            ...relation,
            targetId: a.id,
            reason: relation.reason,
          });
        }
      }
    }

    // Sort relations by strength descending for efficient traversal
    for (const node of this.nodes.values()) {
      node.relations.sort((a, b) => b.strength - a.strength);
    }
  }

  /**
   * Find entries related to the given entry, up to `maxResults` and
   * within `maxDistance` hops.
   */
  findRelated(
    entryId: string,
    options: { maxResults?: number; maxDistance?: number } = {},
  ): RelatedMemory[] {
    const maxResults = options.maxResults ?? 10;
    const maxDistance = options.maxDistance ?? 2;

    const visited = new Set<string>();
    const results: RelatedMemory[] = [];
    const queue: Array<{ id: string; distance: number }> = [
      { id: entryId, distance: 0 },
    ];

    while (queue.length > 0 && results.length < maxResults) {
      const current = queue.shift()!;
      if (visited.has(current.id)) continue;
      visited.add(current.id);

      const node = this.nodes.get(current.id);
      if (!node) continue;

      for (const rel of node.relations) {
        if (visited.has(rel.targetId)) continue;
        if (current.distance + 1 > maxDistance) continue;

        const entry = this.entryStore.get(rel.targetId);
        if (!entry) continue;

        // Don't include the query entry itself
        if (rel.targetId !== entryId) {
          results.push({
            entry,
            relation: rel,
            distance: current.distance + 1,
          });
        }

        if (results.length >= maxResults) break;
        queue.push({ id: rel.targetId, distance: current.distance + 1 });
      }
    }

    // Sort by: distance first, then relation strength
    results.sort((a, b) => {
      const d = a.distance - b.distance;
      if (d !== 0) return d;
      return b.relation.strength - a.relation.strength;
    });

    return results.slice(0, maxResults);
  }

  /**
   * Find the shortest path between two entries in the graph.
   * Returns the chain of entry IDs, or empty if no path exists.
   */
  findPath(fromId: string, toId: string): string[] {
    if (fromId === toId) return [fromId];

    const visited = new Set<string>();
    const parent = new Map<string, string>();
    const queue: string[] = [fromId];
    visited.add(fromId);

    while (queue.length > 0) {
      const current = queue.shift()!;
      const node = this.nodes.get(current);
      if (!node) continue;

      for (const rel of node.relations) {
        if (visited.has(rel.targetId)) continue;
        visited.add(rel.targetId);
        parent.set(rel.targetId, current);

        if (rel.targetId === toId) {
          // Reconstruct path
          const path: string[] = [toId];
          let cur = toId;
          while (parent.has(cur)) {
            cur = parent.get(cur)!;
            path.unshift(cur);
          }
          return path;
        }

        queue.push(rel.targetId);
      }
    }

    return []; // No path found
  }

  /**
   * Get the number of nodes and edges in the graph.
   */
  stats(): { nodes: number; edges: number; avgDegree: number } {
    let totalEdges = 0;
    for (const node of this.nodes.values()) {
      totalEdges += node.relations.length;
    }
    // Each edge is counted twice (once per endpoint)
    const edges = totalEdges / 2;
    const nodes = this.nodes.size;
    return {
      nodes,
      edges,
      avgDegree: nodes > 0 ? totalEdges / nodes : 0,
    };
  }

  /**
   * Get the node for a specific entry, if it exists.
   */
  getNode(entryId: string): GraphNode | undefined {
    return this.nodes.get(entryId);
  }

  // ─── Private ─────────────────────────────────────────────────────────────

  /**
   * Compute the relation between two entries.
   * Returns null if no meaningful relation exists.
   */
  private computeRelation(
    a: MemoryEntry,
    b: MemoryEntry,
  ): Omit<MemoryRelation, "targetId"> | null {
    let totalStrength = 0;
    let primaryReason: MemoryRelation["reason"] = "keyword";

    // Keyword overlap
    const aKeywords = new Set(
      extractKeywords(a.content + " " + a.tags.join(" ")),
    );
    const bKeywords = new Set(
      extractKeywords(b.content + " " + b.tags.join(" ")),
    );
    let keywordOverlap = 0;
    for (const kw of aKeywords) {
      if (bKeywords.has(kw)) keywordOverlap++;
    }

    if (keywordOverlap >= this.options.minKeywordOverlap) {
      const maxKeywords = Math.max(aKeywords.size, bKeywords.size);
      const keywordScore = maxKeywords > 0
        ? (keywordOverlap / maxKeywords) * this.options.keywordWeight
        : 0;
      totalStrength += keywordScore;
      primaryReason = "keyword";
    }

    // Tag overlap
    const aTags = new Set(a.tags);
    let tagOverlap = 0;
    for (const tag of b.tags) {
      if (aTags.has(tag)) tagOverlap++;
    }

    if (tagOverlap >= this.options.minTagOverlap) {
      const maxTags = Math.max(a.tags.length, b.tags.length);
      const tagScore = maxTags > 0
        ? (tagOverlap / maxTags) * this.options.tagWeight
        : 0;
      totalStrength += tagScore;
      if (tagOverlap > keywordOverlap) primaryReason = "tag";
    }

    // Co-occurrence: entries created within a time window
    const aTime = new Date(a.createdAt).getTime();
    const bTime = new Date(b.createdAt).getTime();
    const timeDiff = Math.abs(aTime - bTime);
    if (timeDiff < this.options.coOccurrenceWindowMs) {
      const closeness = 1 - timeDiff / this.options.coOccurrenceWindowMs;
      totalStrength += closeness * this.options.coOccurrenceWeight;
      if (totalStrength > 0 && primaryReason === "keyword" && keywordOverlap < this.options.minKeywordOverlap) {
        primaryReason = "co-occurrence";
      }
    }

    // Only create a relation if total strength is meaningful
    if (totalStrength < 0.1) return null;

    return {
      strength: Math.min(totalStrength, 1.0),
      reason: primaryReason,
    };
  }
}
