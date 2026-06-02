/**
 * Unit tests for detectUsage, extractKeywords, memoryKeywords (detector.ts).
 *
 * Coverage targets all branches: keyword extraction / dedup / stop words /
 * short tokens, memory keyword construction with and without description,
 * detection with keywordEnabled on/off, thresholding, sideQuery
 * ambiguous-zone escalation, lowBound rejection, and empty-input paths.
 */
import { describe, it, expect, vi } from "vitest";
import { detectUsage, extractKeywords, memoryKeywords } from "../detector.js";
import type { MemoryFile, DetectorConfig } from "../types.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeMemory(overrides: Partial<MemoryFile> = {}): MemoryFile {
  return {
    path: "/mem/test-file.md",
    filename: "test-file.md",
    type: "project",
    description: "A test memory file",
    mtimeMs: 1_700_000_000_000,
    ...overrides,
  };
}

function sideQueryClassify(
  returnPaths: string[],
): (response: string, memories: MemoryFile[]) => Promise<string[]> {
  return vi.fn().mockResolvedValue(returnPaths);
}

function configWithSideQuery(
  classify: (response: string, memories: MemoryFile[]) => Promise<string[]>,
  overrides: Partial<DetectorConfig> = {},
): DetectorConfig {
  return {
    keywordEnabled: true,
    keywordThreshold: 0.5,
    sideQuery: {
      lowBound: 0.1,
      highBound: 0.8,
      classify,
    },
    ...overrides,
  };
}

// ── extractKeywords ──────────────────────────────────────────────────────────

describe("extractKeywords", () => {
  it("extracts meaningful lowercase keywords from normal text", () => {
    const result = extractKeywords("Quick Brown Fox Jumps");
    expect(result).toEqual(["quick", "brown", "fox", "jumps"]);
  });

  it("returns empty array for empty string", () => {
    expect(extractKeywords("")).toEqual([]);
  });

  it("filters out stop words entirely", () => {
    // All tokens are stop words
    expect(extractKeywords("the and but or was were")).toEqual([]);
  });

  it("filters out tokens shorter than 3 characters", () => {
    expect(extractKeywords("ab cd ef xy zz")).toEqual([]);
  });

  it("filters out stop words while keeping meaningful keywords", () => {
    const result = extractKeywords("the deploy and server but broken");
    // stop words: the, and, but. keep: deploy, server, broken
    expect(result).toEqual(["deploy", "server", "broken"]);
  });

  it("deduplicates keywords preserving first-occurrence order", () => {
    const result = extractKeywords("deploy deploy server deploy server");
    expect(result).toEqual(["deploy", "server"]);
  });

  it("handles multiple consecutive separators", () => {
    const result = extractKeywords("hello,,,world!!!test   extra");
    expect(result).toContain("hello");
    expect(result).toContain("world");
    expect(result).toContain("test");
    expect(result).toContain("extra");
  });

  it("trims and lowercases tokens", () => {
    const result = extractKeywords("  HELLO   World  ");
    expect(result).toEqual(["hello", "world"]);
  });

  it("handles mixed stop words, short tokens, and valid keywords", () => {
    const result = extractKeywords("I am building a fast API system today");
    // stop: i, am, are (wait, "am" isn't in stop words...), "a" is
    // Actually "i" IS a stop word, "am" is NOT (not in the list!)
    // Let me check: i → yes stop word; am → NOT in the list; a → yes stop word
    // tokens: I(→stop), am(→keep, len=2→too short), building(keep), a(stop),
    //         fast(keep), API(stop? no, keep), system(keep), today(keep)
    // Wait "API" is length 3, not stop word. "api" → keep
    // So: building, fast, api, system, today
    expect(result).toContain("building");
    expect(result).toContain("fast");
    expect(result).toContain("api");
    expect(result).toContain("system");
    expect(result).toContain("today");
  });
});

// ── memoryKeywords ───────────────────────────────────────────────────────────

describe("memoryKeywords", () => {
  it("extracts keywords from both description and filename", () => {
    const mem = makeMemory({
      description: "deploy production server",
      filename: "guides/deploy.md",
    });
    const result = memoryKeywords(mem);
    // description → deploy, production, server
    // filename stem → guides deploy (after de-suffixing)
    // combined dedup → deploy, production, server, guides
    expect(result).toContain("deploy");
    expect(result).toContain("production");
    expect(result).toContain("server");
    expect(result).toContain("guides");
  });

  it("handles null description gracefully (filename only)", () => {
    const mem = makeMemory({
      description: null,
      filename: "api-reference.md",
    });
    const result = memoryKeywords(mem);
    // filename stem → api reference
    expect(result).toContain("api");
    expect(result).toContain("reference");
  });

  it("strips .md extension from filename", () => {
    const mem = makeMemory({
      description: null,
      filename: "setup.md",
    });
    const result = memoryKeywords(mem);
    // stem → "setup" (no .md)
    expect(result).toContain("setup");
    // should NOT contain "md" as a keyword
    expect(result).not.toContain("md");
  });

  it("replaces forward slashes with spaces in filename", () => {
    const mem = makeMemory({
      description: null,
      filename: "guides/deploy/checklist.md",
    });
    const result = memoryKeywords(mem);
    expect(result).toContain("guides");
    expect(result).toContain("deploy");
    expect(result).toContain("checklist");
  });

  it("replaces backslashes with spaces in filename", () => {
    const mem = makeMemory({
      description: null,
      filename: "guides\\deploy\\checklist.md",
    });
    const result = memoryKeywords(mem);
    expect(result).toContain("guides");
    expect(result).toContain("deploy");
    expect(result).toContain("checklist");
  });

  it("replaces hyphens and underscores with spaces in filename", () => {
    const mem = makeMemory({
      description: null,
      filename: "api-design_version.md",
    });
    const result = memoryKeywords(mem);
    expect(result).toContain("api");
    expect(result).toContain("design");
    // underscore also replaced with space, version >= 3 chars preserved
    expect(result).toContain("version");
  });

  it("returns empty when neither description nor filename stem yields keywords", () => {
    const mem = makeMemory({
      description: null,
      filename: "ab.md", // "ab" length 2 < 3 → filtered out
    });
    const result = memoryKeywords(mem);
    expect(result).toEqual([]);
  });
});

// ── detectUsage ──────────────────────────────────────────────────────────────

describe("detectUsage", () => {
  // --- keywordEnabled = false ---

  it("returns all unused (score 0, no matched keywords) when keywordEnabled is false", async () => {
    const mem = makeMemory({ description: "deploy server configuration" });
    const results = await detectUsage(
      "we deployed the server today",
      [mem],
      { keywordEnabled: false, keywordThreshold: 0.2 },
    );
    expect(results).toHaveLength(1);
    expect(results[0]!.used).toBe(false);
    expect(results[0]!.score).toBe(0);
    expect(results[0]!.matchedKeywords).toEqual([]);
  });

  // --- empty memories ---

  it("returns empty array for empty memories list", async () => {
    const results = await detectUsage("some response text", []);
    expect(results).toEqual([]);
  });

  it("returns all unused for empty memories even with keywordEnabled=false", async () => {
    const results = await detectUsage(
      "response",
      [],
      { keywordEnabled: false, keywordThreshold: 0.2 },
    );
    expect(results).toEqual([]);
  });

  // --- default config ---

  it("uses default config (keywordEnabled=true, threshold=0.2) when no config provided", async () => {
    const mem = makeMemory({
      description: "deploy server notes",
      filename: "deploy.md",
    });
    // keywords: deploy, server, notes → 3 keywords
    // response with "deploy" only → 1/3 ≈ 0.33 >= 0.2 → used
    const results = await detectUsage("let us deploy the application", [mem]);
    expect(results).toHaveLength(1);
    expect(results[0]!.used).toBe(true);
  });

  // --- score >= threshold ---

  it("marks memory as used when keyword score meets threshold", async () => {
    // memory "deploy server" + filename "notes.md" → 3 keywords: deploy, server, notes
    const mem = makeMemory({ description: "deploy server", filename: "notes.md" });
    // response contains "deploy" → 1/3 ≈ 0.333 >= 0.3 threshold
    const results = await detectUsage(
      "we should deploy this change",
      [mem],
      { keywordEnabled: true, keywordThreshold: 0.3 },
    );
    expect(results[0]!.used).toBe(true);
    expect(results[0]!.score).toBeCloseTo(1 / 3);
    expect(results[0]!.matchedKeywords).toContain("deploy");
  });

  it("marks memory as used when all keywords match (score = 1.0)", async () => {
    const mem = makeMemory({
      description: "deploy server",
      filename: "notes.md",
    });
    // keywords: deploy, server, notes
    const results = await detectUsage(
      "deploy server notes",
      [mem],
      { keywordEnabled: true, keywordThreshold: 0.5 },
    );
    expect(results[0]!.used).toBe(true);
    expect(results[0]!.score).toBe(1.0);
    expect(results[0]!.matchedKeywords).toEqual(
      expect.arrayContaining(["deploy", "server", "notes"]),
    );
  });

  // --- score < threshold, no sideQuery ---

  it("marks memory as unused when score is below threshold and no sideQuery", async () => {
    // keywords: deploy, server, notes (3)
    // response contains only "deploy" → 1/3 ≈ 0.33 < 0.5 threshold
    const mem = makeMemory({ description: "deploy server", filename: "notes.md" });
    const results = await detectUsage(
      "we will deploy the changes",
      [mem],
      { keywordEnabled: true, keywordThreshold: 0.5 },
    );
    expect(results[0]!.used).toBe(false);
    expect(results[0]!.score).toBeCloseTo(1 / 3);
  });

  it("returns score=0 when no keywords match the response", async () => {
    // keywords: deploy, server, notes (3)
    // response contains none of these
    const mem = makeMemory({ description: "deploy server", filename: "notes.md" });
    const results = await detectUsage(
      "completely unrelated text about bananas",
      [mem],
      { keywordEnabled: true, keywordThreshold: 0.2 },
    );
    expect(results[0]!.used).toBe(false);
    expect(results[0]!.score).toBe(0);
    expect(results[0]!.matchedKeywords).toEqual([]);
  });

  // --- sideQuery: ambiguous zone → classify returns path ---

  it("escalates ambiguous score to sideQuery and marks used when classify returns path", async () => {
    // keywords: deploy, server, notes (3)
    // response with "deploy" → 1/3 ≈ 0.33, threshold=0.5, lowBound=0.1 → ambiguous
    const mem = makeMemory({
      path: "/mem/deploy.md",
      description: "deploy server",
      filename: "notes.md",
    });
    const classify = sideQueryClassify(["/mem/deploy.md"]);
    const config = configWithSideQuery(classify, {
      keywordThreshold: 0.5,
      sideQuery: { lowBound: 0.1, highBound: 0.8, classify },
    });

    const results = await detectUsage(
      "we need to deploy this",
      [mem],
      config,
    );

    expect(classify).toHaveBeenCalledTimes(1);
    expect(classify).toHaveBeenCalledWith(
      "we need to deploy this",
      [mem],
    );
    expect(results[0]!.used).toBe(true);
    // score boosted to at least keywordThreshold
    expect(results[0]!.score).toBe(0.5);
  });

  // --- sideQuery: ambiguous zone → classify does NOT return path ---

  it("leaves memory as unused when sideQuery does not return its path", async () => {
    const mem = makeMemory({
      path: "/mem/deploy.md",
      description: "deploy server",
      filename: "notes.md",
    });
    const classify = sideQueryClassify([]); // returns empty → not used
    const config = configWithSideQuery(classify, {
      keywordThreshold: 0.5,
      sideQuery: { lowBound: 0.1, highBound: 0.8, classify },
    });

    const results = await detectUsage(
      "we need to deploy this",
      [mem],
      config,
    );

    expect(classify).toHaveBeenCalledTimes(1);
    expect(results[0]!.used).toBe(false);
    // score unchanged (still ~0.33)
    expect(results[0]!.score).toBeCloseTo(1 / 3);
  });

  // --- sideQuery: score below lowBound → not ambiguous → unused ---

  it("marks memory as unused when score is below sideQuery lowBound", async () => {
    // keywords: deploy, server, notes (3)
    // response with "deploy" → 1/3 ≈ 0.33, lowBound=0.4 → 0.33 < 0.4 → used=false
    const mem = makeMemory({ description: "deploy server", filename: "notes.md" });
    const classify = sideQueryClassify(["/mem/notes.md"]);
    const config = configWithSideQuery(classify, {
      keywordThreshold: 0.5,
      sideQuery: { lowBound: 0.4, highBound: 0.8, classify },
    });

    const results = await detectUsage(
      "we need to deploy this",
      [mem],
      config,
    );

    // sideQuery should NOT be called because score < lowBound
    expect(classify).not.toHaveBeenCalled();
    expect(results[0]!.used).toBe(false);
  });

  // --- sideQuery: score >= threshold (above highBound effectively) ---

  it("marks memory as used without calling sideQuery when score >= threshold", async () => {
    // keywords: deploy, server, notes (3)
    // response contains all → score=1.0 >= 0.5 threshold
    const mem = makeMemory({ description: "deploy server", filename: "notes.md" });
    const classify = sideQueryClassify([]);
    const config = configWithSideQuery(classify, {
      keywordThreshold: 0.5,
      sideQuery: { lowBound: 0.1, highBound: 0.8, classify },
    });

    const results = await detectUsage(
      "deploy the server notes here",
      [mem],
      config,
    );

    // sideQuery not called because score >= threshold
    expect(classify).not.toHaveBeenCalled();
    expect(results[0]!.used).toBe(true);
    expect(results[0]!.score).toBe(1.0);
  });

  // --- no ambiguous results → sideQuery not called ---

  it("skips sideQuery when no results fall in the ambiguous zone", async () => {
    // Memory 1: score >= threshold → used (not ambiguous)
    const mem1 = makeMemory({
      path: "/mem/a.md",
      description: "deploy server notes",
      filename: "a.md",
    });
    // Memory 2: score = 0 (no keywords match) → unused, below lowBound
    const mem2 = makeMemory({
      path: "/mem/b.md",
      description: "database migration",
      filename: "b.md",
    });
    // Response only matches mem1 keywords, nothing for mem2
    const classify = sideQueryClassify([]);
    const config = configWithSideQuery(classify, {
      keywordThreshold: 0.3,
      sideQuery: { lowBound: 0.1, highBound: 0.8, classify },
    });

    const results = await detectUsage(
      "deploy server notes",
      [mem1, mem2],
      config,
    );

    // mem1: all keywords match → score=1.0 >= 0.3 → used, not ambiguous
    // mem2: 0 keywords match → score=0 < 0.1 → below lowBound, not ambiguous
    // No ambiguous results → sideQuery not called
    expect(classify).not.toHaveBeenCalled();
    expect(results[0]!.used).toBe(true);
    expect(results[1]!.used).toBe(false);
  });

  // --- multiple memories, mixed results ---

  it("handles multiple memories with mixed detection outcomes", async () => {
    const mem1 = makeMemory({
      path: "/mem/deploy.md",
      description: "deploy server",
      filename: "deploy.md",
    });
    const mem2 = makeMemory({
      path: "/mem/database.md",
      description: "database migration",
      filename: "database.md",
    });
    const mem3 = makeMemory({
      path: "/mem/logging.md",
      description: "logging monitoring",
      filename: "logging.md",
    });

    // Response mentions deploy and database but not logging
    // mem1: keywords deploy, server → "deploy" matches → 1/2=0.5
    // mem2: keywords database, migration → "database" matches → 1/2=0.5
    // mem3: keywords logging, monitoring → none match → 0/2=0.0
    const results = await detectUsage(
      "we need to deploy the database changes",
      [mem1, mem2, mem3],
      { keywordEnabled: true, keywordThreshold: 0.4 },
    );

    expect(results).toHaveLength(3);
    expect(results[0]!.used).toBe(true);  // deploy → 0.5 >= 0.4
    expect(results[1]!.used).toBe(true);  // database → 0.5 >= 0.4
    expect(results[2]!.used).toBe(false); // logging → 0.0 < 0.4
  });

  // --- mixed: some above threshold, some ambiguous with sideQuery ---

  it("calls sideQuery for ambiguous results while keeping above-threshold results used", async () => {
    const memAbove = makeMemory({
      path: "/mem/above.md",
      description: "deploy server notes",
      filename: "above.md",
    });
    const memAmbig = makeMemory({
      path: "/mem/ambig.md",
      description: "database migration schema",
      filename: "ambig.md",
    });

    // Response: "deploy server notes" + "database" only
    // memAbove: all 3 keywords match → score=1.0 >= 0.5 → used
    // memAmbig: only "database" matches out of 3 → score=0.33, in [0.1, 0.5) → ambiguous
    const classify = sideQueryClassify(["/mem/ambig.md"]);
    const config = configWithSideQuery(classify, {
      keywordThreshold: 0.5,
      sideQuery: { lowBound: 0.1, highBound: 0.8, classify },
    });

    const results = await detectUsage(
      "deploy server notes and database setup",
      [memAbove, memAmbig],
      config,
    );

    expect(classify).toHaveBeenCalledTimes(1);
    // sideQuery receives only the ambiguous memory
    expect(classify).toHaveBeenCalledWith(
      "deploy server notes and database setup",
      [memAmbig],
    );
    expect(results[0]!.used).toBe(true); // above threshold
    expect(results[1]!.used).toBe(true); // sideQuery approved
  });

  // --- mixed: some above, some ambiguous, sideQuery rejects some ---

  it("handles mixed sideQuery where some ambiguous are approved and some rejected", async () => {
    const mem1 = makeMemory({
      path: "/mem/above.md",
      description: "deploy server notes",
      filename: "above.md",
    });
    const mem2 = makeMemory({
      path: "/mem/approved.md",
      description: "database migration schema",
      filename: "approved.md",
    });
    const mem3 = makeMemory({
      path: "/mem/rejected.md",
      description: "logging monitoring alerts",
      filename: "rejected.md",
    });

    // Response: "deploy server notes database"
    // mem1: all 3 keywords → 1.0 >= 0.5 → used
    // mem2: only "database" out of 3 → 0.33, in [0.1, 0.5) → ambiguous
    // mem3: none match → 0.0 < 0.1 → unused
    const classify = sideQueryClassify(["/mem/approved.md"]); // only approve mem2
    const config = configWithSideQuery(classify, {
      keywordThreshold: 0.5,
      sideQuery: { lowBound: 0.1, highBound: 0.8, classify },
    });

    const results = await detectUsage(
      "deploy server notes database setup",
      [mem1, mem2, mem3],
      config,
    );

    expect(classify).toHaveBeenCalledTimes(1);
    // mem3 is below lowBound, not included in the ambiguous batch
    expect(classify).toHaveBeenCalledWith(
      "deploy server notes database setup",
      [mem2],
    );
    expect(results[0]!.used).toBe(true);  // above threshold
    expect(results[1]!.used).toBe(true);  // sideQuery approved
    expect(results[2]!.used).toBe(false); // below lowBound
  });

  // --- Path matching includes matchedKeywords and score ---

  it("returns matchedKeywords for each memory", async () => {
    const mem = makeMemory({
      description: "deploy production server",
      filename: "deploy.md",
    });
    // keywords: deploy, production, server
    // response: "deploy production" → matches deploy + production, not server

    const results = await detectUsage(
      "deploy production changes",
      [mem],
      { keywordEnabled: true, keywordThreshold: 0.3 },
    );

    expect(results[0]!.matchedKeywords).toContain("deploy");
    expect(results[0]!.matchedKeywords).toContain("production");
    expect(results[0]!.matchedKeywords).not.toContain("server");
    expect(results[0]!.score).toBeCloseTo(2 / 3);
  });

  // --- Case insensitive matching ---

  it("matches keywords case-insensitively", async () => {
    const mem = makeMemory({
      description: "Deploy Server",
      filename: "DEPLOY.md",
    });
    // keywords lowercase: deploy, server
    const results = await detectUsage(
      "DEPLOY the SERVER",
      [mem],
      { keywordEnabled: true, keywordThreshold: 0.5 },
    );

    expect(results[0]!.used).toBe(true);
    expect(results[0]!.score).toBe(1.0);
  });

  // --- Memory with no extractable keywords (keywordScore returns 0) ---

  it("returns score=0 when memory has no extractable keywords", async () => {
    const mem = makeMemory({
      description: null,
      filename: "ab.md", // "ab" < 3 chars → no keywords
    });
    const results = await detectUsage(
      "some response text",
      [mem],
      { keywordEnabled: true, keywordThreshold: 0.2 },
    );
    expect(results[0]!.score).toBe(0);
    expect(results[0]!.matchedKeywords).toEqual([]);
    expect(results[0]!.used).toBe(false);
  });

  // --- sideQuery with multiple ambiguous memories, batch call ---

  it("batches multiple ambiguous results into a single sideQuery call", async () => {
    const mem1 = makeMemory({
      path: "/mem/a.md",
      description: "deploy server notes",
      filename: "a.md",
    });
    const mem2 = makeMemory({
      path: "/mem/b.md",
      description: "database migration schema",
      filename: "b.md",
    });
    const mem3 = makeMemory({
      path: "/mem/c.md",
      description: "logging monitoring alerts",
      filename: "c.md",
    });

    // Response: "deploy database" — each memory has one matching keyword out of 3
    // mem1: deploy → 1/3=0.33 (ambiguous with lowBound=0.1, threshold=0.5)
    // mem2: database → 1/3=0.33 (ambiguous)
    // mem3: 0/3=0.0 (below lowBound → not ambiguous)
    const classify = sideQueryClassify(["/mem/a.md", "/mem/b.md"]);
    const config = configWithSideQuery(classify, {
      keywordThreshold: 0.5,
      sideQuery: { lowBound: 0.1, highBound: 0.8, classify },
    });

    const results = await detectUsage(
      "deploy database setup",
      [mem1, mem2, mem3],
      config,
    );

    expect(classify).toHaveBeenCalledTimes(1);
    expect(classify).toHaveBeenCalledWith(
      "deploy database setup",
      expect.arrayContaining([mem1, mem2]),
    );
    expect(results[0]!.used).toBe(true);
    expect(results[1]!.used).toBe(true);
    expect(results[2]!.used).toBe(false);
  });

  // --- sideQuery classify receives correct memories in order ---

  it("passes only ambiguous zone memories to sideQuery in correct order", async () => {
    const mem1 = makeMemory({
      path: "/mem/1.md",
      description: "alpha beta gamma",
      filename: "1.md",
    });
    const mem2 = makeMemory({
      path: "/mem/2.md",
      description: "delta epsilon zeta",
      filename: "2.md",
    });

    // Response: "alpha delta" → each memory gets 1/3 match → 0.33 ambiguous
    const classify = sideQueryClassify(["/mem/1.md"]);
    const config = configWithSideQuery(classify, {
      keywordThreshold: 0.5,
      sideQuery: { lowBound: 0.1, highBound: 0.8, classify },
    });

    await detectUsage("alpha delta test", [mem1, mem2], config);

    expect(classify).toHaveBeenCalledWith(
      "alpha delta test",
      [mem1, mem2],
    );
  });

  // --- score boosted to threshold when sideQuery approves ---

  it("boosts score to at least keywordThreshold when sideQuery approves", async () => {
    const mem = makeMemory({
      path: "/mem/low.md",
      description: "alpha beta gamma delta",
      filename: "low.md",
    });
    // keywords: alpha, beta, gamma, delta (4)
    // Response: "alpha" → 1/4=0.25, threshold=0.5, lowBound=0.1 → ambiguous
    const classify = sideQueryClassify(["/mem/low.md"]);
    const config = configWithSideQuery(classify, {
      keywordThreshold: 0.5,
      sideQuery: { lowBound: 0.1, highBound: 0.8, classify },
    });

    const results = await detectUsage("alpha test", [mem], config);

    expect(results[0]!.used).toBe(true);
    // score should be max(0.25, 0.5) = 0.5
    expect(results[0]!.score).toBe(0.5);
  });

  // --- sideQuery edge: lowBound equals score → ambiguous (>= ) ---

  it("treats score exactly at lowBound as ambiguous", async () => {
    // keywords: deploy, server, notes (3)
    // response: "deploy" → 1/3=0.333... lowBound=0.333 → score >= lowBound → ambiguous
    const mem = makeMemory({
      path: "/mem/deploy.md",
      description: "deploy server",
      filename: "notes.md",
    });
    const classify = sideQueryClassify(["/mem/deploy.md"]);
    const config = configWithSideQuery(classify, {
      keywordThreshold: 0.5,
      sideQuery: { lowBound: 1 / 3, highBound: 0.8, classify },
    });

    const results = await detectUsage(
      "we must deploy today",
      [mem],
      config,
    );

    // score ≈ 0.333, lowBound = 0.333 → score >= lowBound → ambiguous
    expect(classify).toHaveBeenCalledTimes(1);
    expect(results[0]!.used).toBe(true);
  });
});
