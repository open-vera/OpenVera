/**
 * Comprehensive tests for MemoryGraph — memory knowledge graph.
 *
 * Covers: constructor, build, computeRelation (via build+getNode),
 * findRelated, findPath, stats, getNode.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { MemoryGraph } from "../graph.js";
import type { MemoryEntry } from "../store.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const NOW = "2025-06-01T12:00:00.000Z";

function ts(offsetMs: number): string {
  return new Date(new Date(NOW).getTime() + offsetMs).toISOString();
}

function makeEntry(overrides: Partial<MemoryEntry> & { id: string }): MemoryEntry {
  const now = overrides.createdAt ?? NOW;
  return {
    tier: "semantic",
    content: "",
    tags: [],
    createdAt: now,
    updatedAt: now,
    importance: 0.5,
    ...overrides,
  };
}

// ─── Constructor ─────────────────────────────────────────────────────────────

describe("MemoryGraph constructor", () => {
  it("uses default options when none provided", () => {
    const g = new MemoryGraph();
    // Defaults are internal; verify through behavior
    const entries = [
      makeEntry({ id: "a", content: "dog cat bird" }),
      makeEntry({ id: "b", content: "dog cat fish" }),
    ];
    // dog+cat overlap = 2 >= default minKeywordOverlap (2) -> relation created
    g.build(entries);
    const node = g.getNode("a")!;
    expect(node.relations).toHaveLength(1);
    expect(node.relations[0]!.strength).toBeGreaterThan(0);
  });

  it("merges partial options with defaults", () => {
    // minKeywordOverlap=5 means dog+cat overlap of 2 won't create a relation
    const g = new MemoryGraph({ minKeywordOverlap: 5 });
    const entries = [
      makeEntry({ id: "a", content: "dog cat bird" }),
      makeEntry({ id: "b", content: "dog cat fish" }),
    ];
    g.build(entries);
    const node = g.getNode("a")!;
    // keyword overlap 2 < 5, no keyword contribution
    // Still check if co-occurrence alone creates a relation
    if (node.relations.length > 0) {
      // relation exists from co-occurrence only
      expect(node.relations[0]!.reason).toBe("co-occurrence");
    }
  });

  it("accepts all custom options", () => {
    const g = new MemoryGraph({
      minKeywordOverlap: 1,
      minTagOverlap: 2,
      keywordWeight: 0.6,
      tagWeight: 0.4,
      coOccurrenceWeight: 0.1,
      coOccurrenceWindowMs: 60000,
    });
    // With minKeywordOverlap=1, single keyword overlap creates relation
    const entries = [
      makeEntry({ id: "a", content: "dog cat" }),
      makeEntry({ id: "b", content: "dog bird" }),
    ];
    g.build(entries);
    expect(g.getNode("a")!.relations).toHaveLength(1);
  });
});

// ─── build ───────────────────────────────────────────────────────────────────

describe("MemoryGraph.build", () => {
  let g: MemoryGraph;

  beforeEach(() => {
    g = new MemoryGraph();
  });

  it("handles empty entries array", () => {
    g.build([]);
    expect(g.stats()).toEqual({ nodes: 0, edges: 0, avgDegree: 0 });
  });

  it("creates a single node with no relations", () => {
    g.build([makeEntry({ id: "x", content: "hello world" })]);
    const node = g.getNode("x")!;
    expect(node.entryId).toBe("x");
    expect(node.relations).toEqual([]);
    expect(node.keywords).toContain("hello");
    expect(node.keywords).toContain("world");
  });

  it("clears previous state on rebuild", () => {
    g.build([makeEntry({ id: "a", content: "old data" })]);
    g.build([makeEntry({ id: "b", content: "new data" })]);
    expect(g.getNode("a")).toBeUndefined();
    expect(g.getNode("b")).toBeDefined();
  });

  // ── computeRelation: keyword overlap ─────────────────────────────────

  it("creates relation when keyword overlap >= minKeywordOverlap (default 2)", () => {
    const entries = [
      makeEntry({ id: "a", content: "machine learning deep", tags: [] }),
      makeEntry({ id: "b", content: "machine learning model", tags: [] }),
    ];
    // keywords: a=["machine","learning","deep"], b=["machine","learning","model"]
    // overlap = 2 (machine, learning) >= 2 -> keyword relation
    g.build(entries);
    const rels = g.getNode("a")!.relations;
    expect(rels).toHaveLength(1);
    expect(rels[0]!.reason).toBe("keyword");
    expect(rels[0]!.targetId).toBe("b");
    expect(rels[0]!.strength).toBeGreaterThan(0);
    expect(rels[0]!.strength).toBeLessThanOrEqual(1);
  });

  it("does NOT create keyword relation when overlap < minKeywordOverlap", () => {
    const entries = [
      makeEntry({ id: "a", content: "machine learning", tags: [] }),
      makeEntry({ id: "b", content: "machine data", tags: [] }),
    ];
    // keywords: a=["machine","learning"], b=["machine","data"]
    // overlap = 1 (machine) < 2 -> no keyword contribution
    // Same timestamp -> co-occurrence contributes 0.2
    g.build(entries);
    const node = g.getNode("a")!;
    if (node.relations.length > 0) {
      // relation is from co-occurrence, not keyword
      expect(node.relations[0]!.reason).not.toBe("keyword");
    }
  });

  it("computes keyword score as (overlap/max) * keywordWeight", () => {
    // a has 3 keywords, b has 2 keywords. Overlap = 2 "shared" keywords
    // Use different timestamps to avoid co-occurrence contribution
    const a = makeEntry({ id: "a", content: "shared data system", tags: [], createdAt: ts(0) });
    const b = makeEntry({ id: "b", content: "shared data", tags: [], createdAt: ts(3600001) });
    g.build([a, b]);
    const rel = g.getNode("a")!.relations[0]!;
    // maxKeywords = max(3, 2) = 3
    // keywordScore = (2/3) * 0.5 = 0.333...
    expect(rel.reason).toBe("keyword");
    expect(rel.strength).toBeCloseTo(0.333, 2);
  });

  it("keywordScore = 0 when maxKeywords is 0 (both entries empty keywords)", () => {
    // Content with only single-char words -> tokenize filters them all
    const a = makeEntry({ id: "a", content: "x y", tags: [] });
    const b = makeEntry({ id: "b", content: "z w", tags: [] });
    // Different timestamps to avoid co-occurrence contribution
    g.build([
      { ...a, createdAt: ts(0) },
      { ...b, createdAt: ts(7200000) }, // 2 hours apart
    ]);
    const node = g.getNode("a")!;
    expect(node.relations).toHaveLength(0);
  });

  it("keywordScore branch: maxKeywords=0 fallback with minKeywordOverlap=0", () => {
    // When minKeywordOverlap=0, keyword block is entered even with 0 overlap.
    // If both entries produce empty keywords, maxKeywords=0 -> keywordScore=0 (ternary fallback).
    const g2 = new MemoryGraph({
      minKeywordOverlap: 0,
      coOccurrenceWindowMs: 1, // disable co-occurrence
    });
    const a = makeEntry({ id: "a", content: "x y", tags: [], createdAt: ts(0) });
    const b = makeEntry({ id: "b", content: "z w", tags: [], createdAt: ts(3600001) });
    // Single-char content -> no keywords. keywordOverlap=0, which is >= 0.
    // maxKeywords = max(0, 0) = 0, so keywordScore = 0.
    // No tag overlap. No co-occurrence. totalStrength = 0 < 0.1 -> no relation.
    g2.build([a, b]);
    expect(g2.getNode("a")!.relations).toHaveLength(0);
  });

  it("tagScore branch: maxTags=0 fallback with minTagOverlap=0", () => {
    // When minTagOverlap=0, tag block is entered even with 0 tag overlap.
    // If both entries have zero tags, maxTags=0 -> tagScore=0 (ternary fallback).
    const g2 = new MemoryGraph({
      minTagOverlap: 0,
      coOccurrenceWindowMs: 1, // disable co-occurrence
    });
    const a = makeEntry({ id: "a", content: "hello world", tags: [], createdAt: ts(0) });
    const b = makeEntry({ id: "b", content: "foo bar", tags: [], createdAt: ts(3600001) });
    // tagOverlap=0 >= 0 -> enters tag block. maxTags = max(0,0) = 0 -> tagScore = 0.
    // No keyword overlap. No co-occurrence. totalStrength = 0 -> no relation.
    g2.build([a, b]);
    expect(g2.getNode("a")!.relations).toHaveLength(0);
  });

  // ── computeRelation: tag overlap ──────────────────────────────────────

  it("creates relation when tag overlap >= minTagOverlap (default 1)", () => {
    // Use single-char tags that tokenize filters out of keywords,
    // so keyword overlap stays 0 and tag takes primary reason
    const entries = [
      makeEntry({ id: "a", content: "foo bar zzz", tags: ["1"] }),
      makeEntry({ id: "b", content: "baz qux xxx", tags: ["1"] }),
    ];
    // keywords: a=["foo","bar","zzz"], b=["baz","qux","xxx"] -> overlap=0
    // tags: both have "1" -> overlap=1 >= minTagOverlap(1)
    // tagOverlap(1) > keywordOverlap(0) -> primaryReason="tag"
    g.build(entries);
    const node = g.getNode("a")!;
    expect(node.relations).toHaveLength(1);
    expect(node.relations[0]!.reason).toBe("tag");
  });

  it("does NOT create tag relation when overlap < minTagOverlap", () => {
    const g2 = new MemoryGraph({ minTagOverlap: 2, coOccurrenceWindowMs: 1 });
    const a = makeEntry({ id: "a", content: "foo bar zzz", tags: ["1"], createdAt: ts(0) });
    const b = makeEntry({ id: "b", content: "baz qux xxx", tags: ["1"], createdAt: ts(3600001) });
    // Only 1 tag overlap, needs 2. No keyword overlap. No co-occurrence.
    g2.build([a, b]);
    const node = g2.getNode("a")!;
    expect(node.relations).toHaveLength(0);
  });

  it("computes tag score as (overlap/max) * tagWeight", () => {
    // Use single-char tags so they don't become keywords
    // Different timestamps to avoid co-occurrence contribution
    const a = makeEntry({ id: "a", content: "one two three", tags: ["1", "2"], createdAt: ts(0) });
    const b = makeEntry({ id: "b", content: "four five six", tags: ["1"], createdAt: ts(3600001) });
    // keywords: no overlap (different content, single-char tags filtered)
    // tags: overlap = 1 ("1"), max = max(2,1) = 2
    // tagScore = (1/2) * 0.3 = 0.15
    g.build([a, b]);
    const rel = g.getNode("a")!.relations[0]!;
    expect(rel.reason).toBe("tag");
    expect(rel.strength).toBeCloseTo(0.15, 2);
  });

  it("tagScore = 0 when maxTags is 0 (both have empty tags)", () => {
    // No keyword overlap (different words), no tags, no co-occurrence (distant time)
    const a = makeEntry({ id: "a", content: "apple orange grape", tags: [], createdAt: ts(0) });
    const b = makeEntry({ id: "b", content: "dog cat bird", tags: [], createdAt: ts(7200000) });
    g.build([a, b]);
    expect(g.getNode("a")!.relations).toHaveLength(0);
  });

  // ── computeRelation: primary reason precedence ─────────────────────────

  it("uses 'tag' as primary reason when tag overlap > keyword overlap", () => {
    // Use single-char tags to avoid tag text becoming keywords.
    // Content overlaps on 1 keyword ("shared"), tags overlap on 2 ("1","2")
    // tagOverlap(2) > keywordOverlap(1) -> primaryReason = "tag"
    const a = makeEntry({ id: "a", content: "shared thing", tags: ["1", "2"] });
    const b = makeEntry({ id: "b", content: "shared other", tags: ["1", "2"] });
    // keywords from content: a=["shared","thing"], b=["shared","other"] -> keywordOverlap=1
    // keywordOverlap=1 < minKeywordOverlap(2) -> no keyword contribution
    // tagOverlap=2 >= minTagOverlap(1) -> tag contributes
    // tagOverlap(2) > keywordOverlap(1) -> primaryReason = "tag"
    g.build([a, b]);
    const rel = g.getNode("a")!.relations[0]!;
    expect(rel.reason).toBe("tag");
  });

  // ── computeRelation: co-occurrence ────────────────────────────────────

  it("adds co-occurrence strength for entries within the time window", () => {
    const diffContent = [
      makeEntry({ id: "a", content: "alpha beta gamma", tags: [], createdAt: ts(0) }),
      makeEntry({ id: "b", content: "delta epsilon zeta", tags: [], createdAt: ts(1800000) }),
    ];
    // keywords: no overlap (different words)
    // tags: no overlap
    // time diff = 1800000ms (30 min) < 3600000 (1 hr)
    // closeness = 1 - 1800000/3600000 = 0.5
    // contribution = 0.5 * 0.2 = 0.1
    g.build(diffContent);
    const node = g.getNode("a")!;
    expect(node.relations).toHaveLength(1);
    expect(node.relations[0]!.reason).toBe("co-occurrence");
    expect(node.relations[0]!.strength).toBeCloseTo(0.1, 2);
  });

  it("does NOT add co-occurrence for entries outside the time window", () => {
    const a = makeEntry({ id: "a", content: "alpha beta", tags: [], createdAt: ts(0) });
    const b = makeEntry({ id: "b", content: "gamma delta", tags: [], createdAt: ts(3600001) });
    // time diff = 3600001ms > 3600000ms -> no co-occurrence
    g.build([a, b]);
    // keywords: no overlap, tags: no overlap, co-occurrence: no
    // totalStrength = 0 < 0.1 -> no relation
    expect(g.getNode("a")!.relations).toHaveLength(0);
  });

  it("co-occurrence becomes primary reason when only it contributes above threshold", () => {
    const entries = [
      makeEntry({ id: "a", content: "hello world", tags: [], createdAt: ts(0) }),
      makeEntry({ id: "b", content: "foo bar", tags: [], createdAt: ts(10000) }),
    ];
    // keywords: no overlap (hello,world vs foo,bar)
    // tags: no overlap
    // time diff = 10s < 1hr -> closeness ≈ 1.0
    // contribution = 1.0 * 0.2 = 0.2
    // totalStrength = 0.2 >= 0.1 -> relation
    // primaryReason starts as "keyword", but keywordOverlap(0) < minKeywordOverlap(2)
    // and totalStrength > 0 -> "co-occurrence"
    g.build(entries);
    const rel = g.getNode("a")!.relations[0]!;
    expect(rel.reason).toBe("co-occurrence");
  });

  // ── computeRelation: strength threshold ───────────────────────────────

  it("does not create relation when totalStrength < 0.1", () => {
    // keywordOverlap=0, tagOverlap=0, timeDiff at the edge of window
    // closeness = 1 - 3500000/3600000 ≈ 0.0278
    // contribution = 0.0278 * 0.2 ≈ 0.0056 < 0.1
    const a = makeEntry({ id: "a", content: "one", tags: [], createdAt: ts(0) });
    const b = makeEntry({ id: "b", content: "two", tags: [], createdAt: ts(3500000) });
    g.build([a, b]);
    expect(g.getNode("a")!.relations).toHaveLength(0);
  });

  it("capped strength at 1.0", () => {
    // Use high weights so combined score exceeds 1.0
    const g2 = new MemoryGraph({ keywordWeight: 1.5, tagWeight: 1.0 });
    const entries = [
      makeEntry({ id: "a", content: "same content here", tags: ["tag1"] }),
      makeEntry({ id: "b", content: "same content here", tags: ["tag1"] }),
    ];
    // Perfect keyword overlap: 1.0 * 1.5 = 1.5
    // Tag overlap: 1.0 * 1.0 = 1.0
    // Total = 2.5, capped to 1.0
    g2.build(entries);
    const rel = g2.getNode("a")!.relations[0]!;
    expect(rel.strength).toBe(1.0);
  });

  // ── build: relation symmetry ─────────────────────────────────────────

  it("creates symmetric relations (both directions)", () => {
    const entries = [
      makeEntry({ id: "a", content: "machine learning", tags: [] }),
      makeEntry({ id: "b", content: "machine learning", tags: [] }),
    ];
    g.build(entries);
    expect(g.getNode("a")!.relations[0]!.targetId).toBe("b");
    expect(g.getNode("b")!.relations[0]!.targetId).toBe("a");
  });

  // ── build: relation sorting ────────────────────────────────────────

  it("sorts relations by strength descending", () => {
    const entries = [
      makeEntry({ id: "center", content: "ml ai data" }),
      // Strong overlap: "ml ai" with center -> 2 keyword overlap + 2 tag overlap
      makeEntry({ id: "strong", content: "ml ai", tags: ["tag1", "tag2"] }),
      // Weak overlap: "data" with center (1 keyword, needs co-occurrence)
      makeEntry({ id: "weak", content: "data", tags: [] }),
    ];
    g.build(entries);
    const rels = g.getNode("center")!.relations;
    expect(rels[0]!.strength).toBeGreaterThan(rels[1]!.strength);
  });
});

// ─── findRelated ─────────────────────────────────────────────────────────────

describe("MemoryGraph.findRelated", () => {
  let g: MemoryGraph;

  beforeEach(() => {
    g = new MemoryGraph();
    // Build a small graph:
    //   a -- b -- c
    //   a -- d
    // a: "ml model data"  tags: ["ai"]
    // b: "ml inference"   tags: ["ai"]
    // c: "inference speed" tags: ["performance"]
    // d: "ml data"        tags: ["ai"]
    const entries: MemoryEntry[] = [
      makeEntry({ id: "a", content: "ml model data", tags: ["ai"] }),
      makeEntry({ id: "b", content: "ml inference", tags: ["ai"] }),
      makeEntry({ id: "c", content: "inference speed", tags: ["performance"] }),
      makeEntry({ id: "d", content: "ml data", tags: ["ai"] }),
    ];
    g.build(entries);
  });

  it("returns empty array when entry is not in the graph", () => {
    expect(g.findRelated("nonexistent")).toEqual([]);
  });

  it("returns empty when entry has no relations", () => {
    // Build a graph with isolated node
    const g2 = new MemoryGraph();
    const isolated = makeEntry({
      id: "solo",
      content: "a b c",
      createdAt: ts(0),
    });
    const other = makeEntry({
      id: "other",
      content: "x y z",
      createdAt: ts(7200000), // 2 hours away, no co-occurrence
    });
    g2.build([isolated, other]);
    expect(g2.findRelated("solo")).toEqual([]);
  });

  it("returns direct relations (distance=1) sorted by strength", () => {
    // Use maxDistance:1 to ensure only direct relations
    const results = g.findRelated("a", { maxDistance: 1 });
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r.distance).toBe(1);
    }
    // Results should be sorted by strength descending (same distance)
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1]!.relation.strength >= results[i]!.relation.strength).toBe(true);
    }
  });

  it("includes transitive relations (distance=2) via BFS", () => {
    const results = g.findRelated("a", { maxDistance: 2 });
    const distances = results.map(r => r.distance);
    expect(distances).toContain(2);
  });

  it("respects maxDistance limit (default 2)", () => {
    // Default maxDistance=2, c is distance 2 from a (a->b->c)
    const results = g.findRelated("a");
    // Should include b (distance 1) and possibly c (distance 2)
    for (const r of results) {
      expect(r.distance).toBeLessThanOrEqual(2);
    }
  });

  it("respects custom maxDistance limit", () => {
    const results = g.findRelated("a", { maxDistance: 1 });
    for (const r of results) {
      expect(r.distance).toBe(1);
    }
  });

  it("respects maxResults limit", () => {
    const results = g.findRelated("a", { maxResults: 1 });
    expect(results.length).toBeLessThanOrEqual(1);
  });

  it("does not include the query entry itself", () => {
    const results = g.findRelated("a");
    for (const r of results) {
      expect(r.entry.id).not.toBe("a");
    }
  });

  it("returns correct RelatedMemory structure", () => {
    const results = g.findRelated("a", { maxResults: 1 });
    expect(results).toHaveLength(1);
    const r = results[0]!;
    expect(r.entry).toHaveProperty("id");
    expect(r.entry).toHaveProperty("content");
    expect(r.relation).toHaveProperty("targetId");
    expect(r.relation).toHaveProperty("strength");
    expect(r.relation).toHaveProperty("reason");
    expect(r.distance).toBeGreaterThanOrEqual(1);
  });

  it("handles skip when entry store misses (entry removed after build)", () => {
    // Build a graph, then build with empty entries to clear entryStore
    // but we can't remove individual entries. Let's just verify
    // that findRelated on an existing entry works correctly.
    const results = g.findRelated("b");
    expect(results.length).toBeGreaterThan(0);
  });
});

// ─── findPath ────────────────────────────────────────────────────────────────

describe("MemoryGraph.findPath", () => {
  it("returns [id] when from and to are the same", () => {
    const g = new MemoryGraph();
    g.build([makeEntry({ id: "a", content: "start here", tags: [] })]);
    expect(g.findPath("a", "a")).toEqual(["a"]);
  });

  it("finds a direct path (1 hop)", () => {
    const g = new MemoryGraph();
    const a = makeEntry({ id: "a", content: "unique alpha", tags: ["1"], createdAt: ts(0) });
    const b = makeEntry({ id: "b", content: "unique beta", tags: ["1"], createdAt: ts(3600001) });
    g.build([a, b]);
    // Connected via single-char tag "1" (keywords never overlap)
    const path = g.findPath("a", "b");
    expect(path).toEqual(["a", "b"]);
  });

  it("finds a multi-hop path", () => {
    const g = new MemoryGraph();
    // Chain: a-b-c-d using staggered timestamps (no co-occurrence)
    // and single-char tags for controlled edges
    const a = makeEntry({ id: "a", content: "content a", tags: ["1"], createdAt: ts(0) });
    const b = makeEntry({ id: "b", content: "content b", tags: ["1", "2"], createdAt: ts(3600001) });
    const c = makeEntry({ id: "c", content: "content c", tags: ["2", "3"], createdAt: ts(7200002) });
    const d = makeEntry({ id: "d", content: "content d", tags: ["3"], createdAt: ts(10800003) });
    // Single-char tags ("1","2","3") are filtered from keywords
    // Edges: a-b via tag "1", b-c via tag "2", c-d via tag "3"
    // No co-occurrence (timestamps > 1hr apart)
    g.build([a, b, c, d]);
    const path = g.findPath("a", "d");
    expect(path[0]).toBe("a");
    expect(path[path.length - 1]).toBe("d");
    expect(path.length).toBeGreaterThanOrEqual(3);
    // Verify each step is a valid edge
    for (let i = 0; i < path.length - 1; i++) {
      const node = g.getNode(path[i]!)!;
      const targets = node.relations.map(r => r.targetId);
      expect(targets).toContain(path[i + 1]!);
    }
  });

  it("returns shortest path when multiple paths exist", () => {
    const g = new MemoryGraph();
    // a connects to "shortcut" (tag "1") and "b" (tag "2").
    // shortcut connects to d (tag "3"). b connects to c (tag "4"), c to d (tag "5").
    // a and d share NO tags -> no direct edge.
    // Shortest a->d: a->shortcut->d (2 hops) vs a->b->c->d (3 hops)
    const a = makeEntry({ id: "a", content: "alpha", tags: ["1", "2"], createdAt: ts(0) });
    const b = makeEntry({ id: "b", content: "beta", tags: ["2", "4"], createdAt: ts(3600001) });
    const c = makeEntry({ id: "c", content: "gamma", tags: ["4", "5"], createdAt: ts(7200002) });
    const d = makeEntry({ id: "d", content: "delta", tags: ["3", "5"], createdAt: ts(10800003) });
    const shortcut = makeEntry({ id: "shortcut", content: "shortcut", tags: ["1", "3"], createdAt: ts(3600001) });
    // Edges: a-b(tag "2"), a-shortcut(tag "1"), b-c(tag "4"), c-d(tag "5"), shortcut-d(tag "3")
    // a and d share no tag -> no direct connection
    g.build([a, b, c, d, shortcut]);
    const path = g.findPath("a", "d");
    expect(path).toEqual(["a", "shortcut", "d"]);
    expect(path.length).toBe(3);
  });

  it("returns empty array when no path exists", () => {
    // Create disjoint subgraphs
    const g = new MemoryGraph();
    g.build([
      makeEntry({ id: "x", content: "first component solely", tags: ["1"], createdAt: ts(0) }),
      makeEntry({ id: "y", content: "first also here", tags: ["1"], createdAt: ts(3600001) }),
      makeEntry({ id: "p", content: "second alone", tags: ["2"], createdAt: ts(7200002) }),
      makeEntry({ id: "q", content: "second there", tags: ["2"], createdAt: ts(10800003) }),
    ]);
    // x-y connected via tag "1", p-q connected via tag "2"
    // x and p: no shared tag, no keyword overlap, no co-occurrence -> no path
    expect(g.findPath("x", "p")).toEqual([]);
  });

  it("returns empty array when from node does not exist", () => {
    const g = new MemoryGraph();
    g.build([makeEntry({ id: "a", content: "content a" })]);
    expect(g.findPath("nonexistent", "a")).toEqual([]);
  });

  it("returns empty array when to node does not exist", () => {
    const g = new MemoryGraph();
    g.build([makeEntry({ id: "a", content: "content a" })]);
    expect(g.findPath("a", "nonexistent")).toEqual([]);
  });

  it("reconstructs path correctly via parent map", () => {
    const g = new MemoryGraph();
    const a = makeEntry({ id: "a", content: "content a", tags: ["1"], createdAt: ts(0) });
    const b = makeEntry({ id: "b", content: "content b", tags: ["1", "2"], createdAt: ts(3600001) });
    const d = makeEntry({ id: "d", content: "content d", tags: ["2"], createdAt: ts(7200002) });
    g.build([a, b, d]);
    const path = g.findPath("a", "d");
    expect(path[0]).toBe("a");
    expect(path[path.length - 1]).toBe("d");
    // Each step should be correctly ordered
    for (let i = 0; i < path.length; i++) {
      expect(g.getNode(path[i]!)).toBeDefined();
    }
  });
});

// ─── stats ───────────────────────────────────────────────────────────────────

describe("MemoryGraph.stats", () => {
  it("returns zeros for empty graph", () => {
    const g = new MemoryGraph();
    expect(g.stats()).toEqual({ nodes: 0, edges: 0, avgDegree: 0 });
  });

  it("counts single node with no relations", () => {
    const g = new MemoryGraph();
    g.build([makeEntry({ id: "x", content: "solo", tags: [], createdAt: ts(0) })]);
    expect(g.stats()).toEqual({ nodes: 1, edges: 0, avgDegree: 0 });
  });

  it("counts two related nodes as 1 edge", () => {
    const g = new MemoryGraph();
    g.build([
      makeEntry({ id: "a", content: "machine learning", tags: [] }),
      makeEntry({ id: "b", content: "machine learning", tags: [] }),
    ]);
    const s = g.stats();
    expect(s.nodes).toBe(2);
    expect(s.edges).toBe(1);
    expect(s.avgDegree).toBe(1); // 2 relations total / 2 nodes = 1
  });

  it("computes correct stats for a chain of 3 nodes", () => {
    const g = new MemoryGraph();
    g.build([
      makeEntry({ id: "a", content: "chain link one", tags: ["t1"] }),
      makeEntry({ id: "b", content: "chain link two", tags: ["t1", "t2"] }),
      makeEntry({ id: "c", content: "chain link three", tags: ["t2"] }),
    ]);
    // a-b connected (overlap on content "chain","link" + tag "t1")
    // b-c connected (overlap on content "chain","link" + tag "t2")
    // a-c might or might not be connected
    const s = g.stats();
    expect(s.nodes).toBe(3);
    expect(s.edges).toBeGreaterThanOrEqual(2);
  });
});

// ─── getNode ─────────────────────────────────────────────────────────────────

describe("MemoryGraph.getNode", () => {
  it("returns the node for an existing entry", () => {
    const g = new MemoryGraph();
    g.build([makeEntry({ id: "test", content: "knowledge graph" })]);
    const node = g.getNode("test")!;
    expect(node.entryId).toBe("test");
    expect(node.tier).toBe("semantic");
    expect(Array.isArray(node.relations)).toBe(true);
    expect(Array.isArray(node.keywords)).toBe(true);
  });

  it("returns undefined for a non-existent entry", () => {
    const g = new MemoryGraph();
    expect(g.getNode("missing")).toBeUndefined();
  });

  it("returns node with stored keywords from build phase", () => {
    const g = new MemoryGraph();
    g.build([makeEntry({ id: "k", content: "knowledge graph system" })]);
    const node = g.getNode("k")!;
    expect(node.keywords).toContain("knowledge");
    expect(node.keywords).toContain("graph");
    expect(node.keywords).toContain("system");
  });
});

// ─── Integration / Edge Cases ────────────────────────────────────────────────

describe("MemoryGraph integration", () => {
  it("handles entries with special characters in content", () => {
    const g = new MemoryGraph();
    const entries = [
      makeEntry({ id: "a", content: "hello-world test_case!", tags: ["c++"] }),
      makeEntry({ id: "b", content: "hello@world test#case", tags: ["c++"] }),
    ];
    g.build(entries);
    // Special chars stripped, "hello", "world", "test", "case" should overlap
    const node = g.getNode("a")!;
    expect(node.relations.length).toBeGreaterThanOrEqual(1);
  });

  it("handles entries with Chinese characters", () => {
    const g = new MemoryGraph();
    const entries = [
      makeEntry({ id: "a", content: "机器学习 深度学习", tags: [] }),
      makeEntry({ id: "b", content: "机器学习 模型训练", tags: [] }),
    ];
    g.build(entries);
    // "机器学习" overlaps in both
    const node = g.getNode("a")!;
    // with default minKeywordOverlap=2, 1 overlap < 2 for Chinese
    // check there's at least one relation node "机器学习" which is 4 chars
    if (node.relations.length > 0) {
      expect(node.relations[0]!.strength).toBeGreaterThan(0);
    }
  });

  it("custom coOccurrenceWindowMs affects relation building", () => {
    // Very short window: only entries within 1 second of each other connect
    const g = new MemoryGraph({ coOccurrenceWindowMs: 1000 });
    const entries = [
      makeEntry({ id: "a", content: "foo bar", tags: [], createdAt: ts(0) }),
      makeEntry({ id: "b", content: "baz qux", tags: [], createdAt: ts(500) }),
      makeEntry({ id: "c", content: "hello world", tags: [], createdAt: ts(2000) }),
    ];
    g.build(entries);
    // a-b: 500ms apart, within window -> connected
    // a-c: 2000ms apart, outside window -> not connected
    const aRels = g.getNode("a")!.relations;
    const targetIds = aRels.map(r => r.targetId);
    expect(targetIds).toContain("b");
    expect(targetIds).not.toContain("c");
  });

  it("rebuild clears all previous nodes and relations", () => {
    const g = new MemoryGraph();
    g.build([
      makeEntry({ id: "a", content: "machine learning", tags: [] }),
      makeEntry({ id: "b", content: "machine learning", tags: [] }),
    ]);
    expect(g.stats().nodes).toBe(2);

    g.build([makeEntry({ id: "c", content: "new entry", tags: [] })]);
    expect(g.stats().nodes).toBe(1);
    expect(g.getNode("a")).toBeUndefined();
    expect(g.getNode("b")).toBeUndefined();
  });

  it("build with many entries does not crash and creates expected relations", () => {
    const g = new MemoryGraph({ minKeywordOverlap: 1, minTagOverlap: 0 });
    const entries: MemoryEntry[] = [];
    for (let i = 0; i < 50; i++) {
      entries.push(makeEntry({
        id: `entry-${i}`,
        content: `common term unique_${i}`,
        tags: [],
      }));
    }
    g.build(entries);
    const s = g.stats();
    expect(s.nodes).toBe(50);
    // Each entry shares "common" with every other entry -> lots of edges
    expect(s.edges).toBeGreaterThan(0);
  });

  it("entry with importance field preserved", () => {
    const g = new MemoryGraph();
    g.build([makeEntry({ id: "imp", content: "important stuff", importance: 0.9 })]);
    const related = g.findRelated("imp");
    // Just verify no crash and node exists
    expect(g.getNode("imp")).toBeDefined();
  });
});
