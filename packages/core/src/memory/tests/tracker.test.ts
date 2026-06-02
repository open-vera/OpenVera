/**
 * Full branch coverage for MemoryTracker.
 *
 * Mocks: scanMemoryDir (scanner) and detectUsage (detector) so we never hit
 * the filesystem or any LLM adapter.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ────────────────────────────────────────────────────────────────────
// vitest hoists vi.mock before all imports, so we use vi.hoisted (which
// runs even earlier) to create the mock function references.

const { mockScanMemoryDir, mockDetectUsage } = vi.hoisted(() => ({
  mockScanMemoryDir: vi.fn(),
  mockDetectUsage: vi.fn(),
}));

vi.mock("../scanner.js", () => ({
  scanMemoryDir: mockScanMemoryDir,
}));

vi.mock("../detector.js", () => ({
  detectUsage: mockDetectUsage,
}));

// Imports after mocks so the tracker resolves to mocked scanner/detector.
import { MemoryTracker } from "../tracker.js";
import type {
  MemoryFile,
  UsageDetectionResult,
} from "../types.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeMemoryFile(overrides: Partial<MemoryFile> = {}): MemoryFile {
  const idx = makeMemoryFile.counter++;
  return {
    path: `/memory/file-${idx}.md`,
    filename: `file-${idx}.md`,
    type: "user",
    description: `Description for file ${idx}`,
    mtimeMs: 1700000000000 + idx * 1000,
    ...overrides,
  };
}
makeMemoryFile.counter = 0;

function makeFiles(count: number): MemoryFile[] {
  return Array.from({ length: count }, () => makeMemoryFile());
}

function resetCounter() {
  makeMemoryFile.counter = 0;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("MemoryTracker", () => {
  beforeEach(() => {
    resetCounter();
    vi.clearAllMocks();
  });

  // ── Constructor ──────────────────────────────────────────────────────────

  describe("constructor", () => {
    it("should set memoryDir and start at turn 0", () => {
      const tracker = new MemoryTracker({ memoryDir: "/test/memory" });
      mockScanMemoryDir.mockResolvedValue([]);
      expect(tracker.currentTurn).toBe(0);
    });

    it("should use default maxInjectPerTurn (5) when not provided", () => {
      const tracker = new MemoryTracker({ memoryDir: "/test" });
      const files = makeFiles(7);
      const selected = tracker.selectForInjection(files);
      expect(selected).toHaveLength(5);
    });

    it("should accept custom maxInjectPerTurn", () => {
      const tracker = new MemoryTracker({
        memoryDir: "/test",
        maxInjectPerTurn: 3,
      });
      const files = makeFiles(5);
      const selected = tracker.selectForInjection(files);
      expect(selected).toHaveLength(3);
    });

    it("should merge partial detector config with defaults", () => {
      const tracker = new MemoryTracker({
        memoryDir: "/test",
        detector: { keywordThreshold: 0.5 },
      });
      expect(tracker).toBeDefined();
    });

    it("should handle fully custom detector config", () => {
      const sideQueryClassify = vi.fn().mockResolvedValue([]);
      const tracker = new MemoryTracker({
        memoryDir: "/test",
        detector: {
          keywordEnabled: false,
          keywordThreshold: 0.8,
          sideQuery: {
            lowBound: 0.1,
            highBound: 0.9,
            classify: sideQueryClassify,
          },
        },
      });
      expect(tracker).toBeDefined();
      expect(tracker.currentTurn).toBe(0);
    });
  });

  // ── scan() ───────────────────────────────────────────────────────────────

  describe("scan", () => {
    it("should delegate to scanMemoryDir and return files", async () => {
      const files = makeFiles(3);
      mockScanMemoryDir.mockResolvedValue(files);

      const tracker = new MemoryTracker({ memoryDir: "/test" });
      const result = await tracker.scan();

      expect(result).toEqual(files);
      expect(mockScanMemoryDir).toHaveBeenCalledWith("/test");
    });

    it("should return empty array when scanner finds nothing", async () => {
      mockScanMemoryDir.mockResolvedValue([]);

      const tracker = new MemoryTracker({ memoryDir: "/empty" });
      const result = await tracker.scan();

      expect(result).toEqual([]);
    });
  });

  // ── selectForInjection ───────────────────────────────────────────────────

  describe("selectForInjection", () => {
    it("should select up to maxInjectPerTurn files", () => {
      const tracker = new MemoryTracker({
        memoryDir: "/test",
        maxInjectPerTurn: 2,
      });
      const files = makeFiles(5);
      const selected = tracker.selectForInjection(files);
      expect(selected).toHaveLength(2);
    });

    it("should return all files when fewer than maxInjectPerTurn", () => {
      const tracker = new MemoryTracker({
        memoryDir: "/test",
        maxInjectPerTurn: 10,
      });
      const files = makeFiles(3);
      const selected = tracker.selectForInjection(files);
      expect(selected).toHaveLength(3);
    });

    it("should give new files neutral priority 0.5 + exploreBoost 0.1 = 0.6", () => {
      const tracker = new MemoryTracker({ memoryDir: "/test" });
      const files = makeFiles(2);

      const selected = tracker.selectForInjection(files);
      // Both are new files: priority = 0.5 + 0.1 = 0.6, so both included
      expect(selected).toHaveLength(2);
      // Tiebreaker by mtime: higher mtime first → file-1 before file-0
      expect(selected[0]!.path).toBe(files[1]!.path);
      expect(selected[1]!.path).toBe(files[0]!.path);
    });

    it("should use mtime as tiebreaker when priorities are equal", () => {
      const tracker = new MemoryTracker({
        memoryDir: "/test",
        maxInjectPerTurn: 2,
      });

      const early = makeMemoryFile({ path: "/mem/early.md", mtimeMs: 1000 });
      const late = makeMemoryFile({ path: "/mem/late.md", mtimeMs: 5000 });

      // Record both so they have stats (hitRate=0, injections=1, no exploreBoost)
      tracker.recordInjection([early.path, late.path]);

      const selected = tracker.selectForInjection([early, late]);
      // Priority = 0 for both, tiebreaker by mtime → late first
      expect(selected[0]!.path).toBe("/mem/late.md");
      expect(selected[1]!.path).toBe("/mem/early.md");
    });

    it("should give exploreBoost (+0.1) to files with zero injections", () => {
      const tracker = new MemoryTracker({
        memoryDir: "/test",
        maxInjectPerTurn: 3,
      });

      const injected = makeMemoryFile({
        path: "/mem/old.md",
        mtimeMs: 5000,
      });
      const fresh = makeMemoryFile({
        path: "/mem/new.md",
        mtimeMs: 1000,
      });

      // Only record "injected" → injections > 0, no exploreBoost
      tracker.recordInjection([injected.path]);

      const selected = tracker.selectForInjection([injected, fresh]);
      // fresh: 0.5 + 0.1 = 0.6; injected: hitRate=0, no boost = 0.0
      expect(selected[0]!.path).toBe("/mem/new.md");
      expect(selected[1]!.path).toBe("/mem/old.md");
    });

    it("should prefer files with higher hitRate over exploreBoost", async () => {
      const tracker = new MemoryTracker({
        memoryDir: "/test",
        maxInjectPerTurn: 2,
      });

      const highHit = makeMemoryFile({
        path: "/mem/high-hit.md",
        mtimeMs: 1000,
      });
      const lowHit = makeMemoryFile({
        path: "/mem/low-hit.md",
        mtimeMs: 2000,
      });
      const fresh = makeMemoryFile({
        path: "/mem/fresh.md",
        mtimeMs: 3000,
      });

      // Record highHit and lowHit, then set up detection
      tracker.recordInjection([highHit.path, lowHit.path]);
      mockDetectUsage.mockResolvedValueOnce([
        { path: "/mem/high-hit.md", used: true, score: 0.9, matchedKeywords: [] },
        { path: "/mem/low-hit.md", used: false, score: 0.0, matchedKeywords: [] },
      ]);
      await tracker.detectAndUpdate("r", [highHit, lowHit]);

      // Now: highHit: 1/1=1.0, lowHit: 0/1=0.0, fresh: 0.5+0.1=0.6
      const selected = tracker.selectForInjection([highHit, lowHit, fresh]);
      expect(selected[0]!.path).toBe("/mem/high-hit.md"); // 1.0
      expect(selected[1]!.path).toBe("/mem/fresh.md"); // 0.6 > 0.0
    });

    it("should truncate when more files than maxInjectPerTurn", () => {
      const tracker = new MemoryTracker({
        memoryDir: "/test",
        maxInjectPerTurn: 1,
      });
      const files = makeFiles(10);
      const selected = tracker.selectForInjection(files);
      expect(selected).toHaveLength(1);
      // With all priorities equal (0.6 for new files), tiebreaker is mtime desc
      expect(selected[0]!.path).toBe(files[9]!.path);
    });
  });

  // ── recordInjection ──────────────────────────────────────────────────────

  describe("recordInjection", () => {
    it("should increment turn on each call", () => {
      const tracker = new MemoryTracker({ memoryDir: "/test" });
      expect(tracker.currentTurn).toBe(0);

      tracker.recordInjection(["/mem/a.md"]);
      expect(tracker.currentTurn).toBe(1);

      tracker.recordInjection(["/mem/b.md"]);
      expect(tracker.currentTurn).toBe(2);
    });

    it("should initialize stats for newly seen files", () => {
      const tracker = new MemoryTracker({ memoryDir: "/test" });
      tracker.recordInjection(["/mem/newfile.md"]);

      const stats = tracker.getStats();
      expect(stats).toHaveLength(1);
      expect(stats[0]!.path).toBe("/mem/newfile.md");
      expect(stats[0]!.injections).toBe(0); // not yet detected
      expect(stats[0]!.hits).toBe(0);
      expect(stats[0]!.hitRate).toBe(0);
      expect(stats[0]!.lastScore).toBe(0);
    });

    it("should not re-create stats entry for already-tracked files", () => {
      const tracker = new MemoryTracker({ memoryDir: "/test" });

      tracker.recordInjection(["/mem/a.md"]);
      const firstStats = tracker.getStats();
      expect(firstStats).toHaveLength(1);

      tracker.recordInjection(["/mem/a.md"]);
      const secondStats = tracker.getStats();
      expect(secondStats).toHaveLength(1); // still one entry, not duplicated
    });

    it("should add injection record to history (newest first)", () => {
      const tracker = new MemoryTracker({ memoryDir: "/test" });
      tracker.recordInjection(["/mem/first.md"]);
      tracker.recordInjection(["/mem/second.md"]);

      const history = tracker.getInjectionHistory();
      expect(history).toHaveLength(2);
      expect(history[0]!.turn).toBe(2);
      expect(history[0]!.injectedPaths).toEqual(["/mem/second.md"]);
      expect(history[1]!.turn).toBe(1);
      expect(history[1]!.injectedPaths).toEqual(["/mem/first.md"]);
    });

    it("should store a copy of paths array (not retain original reference)", () => {
      const tracker = new MemoryTracker({ memoryDir: "/test" });
      const paths = ["/mem/a.md"];
      tracker.recordInjection(paths);

      // Mutate original — injected paths in record should be unaffected
      paths.push("/mem/b.md");

      const history = tracker.getInjectionHistory();
      expect(history[0]!.injectedPaths).toEqual(["/mem/a.md"]);
    });

    it("should set pendingInjection that detectAndUpdate consumes", async () => {
      const tracker = new MemoryTracker({ memoryDir: "/test" });
      const mA = makeMemoryFile({ path: "/mem/a.md" });
      const mB = makeMemoryFile({ path: "/mem/b.md" });

      mockDetectUsage.mockResolvedValue([]);
      tracker.recordInjection(["/mem/a.md", "/mem/b.md"]);
      await tracker.detectAndUpdate("response", [mA, mB]);

      // Both stats entries should exist (initialized during recordInjection)
      const stats = tracker.getStats();
      expect(stats).toHaveLength(2);
    });

    it("should produce correct history timestamp format", () => {
      const tracker = new MemoryTracker({ memoryDir: "/test" });
      tracker.recordInjection(["/mem/a.md"]);

      const history = tracker.getInjectionHistory();
      expect(history[0]!.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });
  });

  // ── detectAndUpdate ──────────────────────────────────────────────────────

  describe("detectAndUpdate", () => {
    it("should pass response, injected memories, and detector config to detectUsage", async () => {
      const tracker = new MemoryTracker({
        memoryDir: "/test",
        detector: { keywordThreshold: 0.3 },
      });

      const mem = makeMemoryFile({ path: "/mem/a.md" });
      mockDetectUsage.mockResolvedValue([]);

      tracker.recordInjection(["/mem/a.md"]);
      await tracker.detectAndUpdate("assistant response", [mem]);

      expect(mockDetectUsage).toHaveBeenCalledWith(
        "assistant response",
        [mem],
        expect.objectContaining({ keywordThreshold: 0.3 }),
      );
    });

    it("should handle null pendingInjection (no prior recordInjection)", async () => {
      const tracker = new MemoryTracker({ memoryDir: "/test" });

      mockDetectUsage.mockResolvedValue([]);
      const results = await tracker.detectAndUpdate("response", []);

      expect(mockDetectUsage).toHaveBeenCalledWith(
        "response",
        [],
        expect.any(Object),
      );
      expect(results).toEqual([]);
    });

    it("should increment hits and injections when file is used", async () => {
      const tracker = new MemoryTracker({ memoryDir: "/test" });
      const mem = makeMemoryFile({
        path: "/mem/a.md",
        filename: "a.md",
        type: "user",
        description: "A memory",
        mtimeMs: 1700000001000,
      });

      mockDetectUsage.mockResolvedValue([
        { path: "/mem/a.md", used: true, score: 0.8, matchedKeywords: ["memory"] },
      ]);

      tracker.recordInjection(["/mem/a.md"]);
      await tracker.detectAndUpdate("response about memory", [mem]);

      const stats = tracker.getStats();
      expect(stats[0]!.injections).toBe(1);
      expect(stats[0]!.hits).toBe(1);
      expect(stats[0]!.hitRate).toBe(1.0);
      expect(stats[0]!.lastScore).toBe(0.8);
    });

    it("should increment only injections when file is NOT used", async () => {
      const tracker = new MemoryTracker({ memoryDir: "/test" });
      const mem = makeMemoryFile({ path: "/mem/a.md" });

      mockDetectUsage.mockResolvedValue([
        { path: "/mem/a.md", used: false, score: 0.05, matchedKeywords: [] },
      ]);

      tracker.recordInjection(["/mem/a.md"]);
      await tracker.detectAndUpdate("unrelated response", [mem]);

      const stats = tracker.getStats();
      expect(stats[0]!.injections).toBe(1);
      expect(stats[0]!.hits).toBe(0);
      expect(stats[0]!.hitRate).toBe(0);
      expect(stats[0]!.lastScore).toBe(0.05);
    });

    it("should accumulate stats across multiple turns", async () => {
      const tracker = new MemoryTracker({ memoryDir: "/test" });
      const mem = makeMemoryFile({ path: "/mem/a.md" });

      // Turn 1: used
      mockDetectUsage.mockResolvedValueOnce([
        { path: "/mem/a.md", used: true, score: 0.9, matchedKeywords: [] },
      ]);
      tracker.recordInjection(["/mem/a.md"]);
      await tracker.detectAndUpdate("r1", [mem]);

      // Turn 2: not used
      mockDetectUsage.mockResolvedValueOnce([
        { path: "/mem/a.md", used: false, score: 0.0, matchedKeywords: [] },
      ]);
      tracker.recordInjection(["/mem/a.md"]);
      await tracker.detectAndUpdate("r2", [mem]);

      // Turn 3: used
      mockDetectUsage.mockResolvedValueOnce([
        { path: "/mem/a.md", used: true, score: 0.7, matchedKeywords: [] },
      ]);
      tracker.recordInjection(["/mem/a.md"]);
      await tracker.detectAndUpdate("r3", [mem]);

      const stats = tracker.getStats();
      expect(stats[0]!.injections).toBe(3);
      expect(stats[0]!.hits).toBe(2);
      expect(stats[0]!.hitRate).toBeCloseTo(2 / 3);
      expect(stats[0]!.lastScore).toBe(0.7);
    });

    it("should backfill metadata from the matching memory file", async () => {
      const tracker = new MemoryTracker({ memoryDir: "/test" });
      const mem = makeMemoryFile({
        path: "/mem/a.md",
        filename: "custom-name.md",
        type: "feedback",
        description: "Feedback memory",
        mtimeMs: 1710000000000,
      });

      mockDetectUsage.mockResolvedValue([
        { path: "/mem/a.md", used: true, score: 0.5, matchedKeywords: [] },
      ]);

      tracker.recordInjection(["/mem/a.md"]);
      await tracker.detectAndUpdate("response", [mem]);

      const stats = tracker.getStats();
      expect(stats[0]!.filename).toBe("custom-name.md");
      expect(stats[0]!.type).toBe("feedback");
      expect(stats[0]!.description).toBe("Feedback memory");
      expect(stats[0]!.mtimeMs).toBe(1710000000000);
    });

    it("should clear pendingInjection after detection completes", async () => {
      const tracker = new MemoryTracker({ memoryDir: "/test" });
      const mem = makeMemoryFile({ path: "/mem/a.md" });

      mockDetectUsage.mockResolvedValue([]);

      tracker.recordInjection(["/mem/a.md"]);
      await tracker.detectAndUpdate("response", [mem]);

      // Second call without recordInjection → pendingInjection is null
      mockDetectUsage.mockResolvedValue([]);
      await tracker.detectAndUpdate("another response", [mem]);

      expect(mockDetectUsage).toHaveBeenLastCalledWith(
        "another response",
        [],
        expect.any(Object),
      );
    });

    it("should skip stats update for paths not in the stats map", async () => {
      const tracker = new MemoryTracker({ memoryDir: "/test" });
      const mem = makeMemoryFile({ path: "/mem/a.md" });

      mockDetectUsage.mockResolvedValue([
        { path: "/mem/unknown.md", used: true, score: 0.9, matchedKeywords: [] },
      ]);

      tracker.recordInjection(["/mem/a.md"]);
      await tracker.detectAndUpdate("response", [mem]);

      // Only the recorded path should have stats
      const stats = tracker.getStats();
      expect(stats).toHaveLength(1);
      expect(stats[0]!.path).toBe("/mem/a.md");
    });

    it("should return the detection results array", async () => {
      const tracker = new MemoryTracker({ memoryDir: "/test" });
      const mem = makeMemoryFile({ path: "/mem/a.md" });

      const expected = [
        { path: "/mem/a.md", used: true, score: 0.75, matchedKeywords: ["key"] },
      ];
      mockDetectUsage.mockResolvedValue(expected);

      tracker.recordInjection(["/mem/a.md"]);
      const results = await tracker.detectAndUpdate("response", [mem]);

      expect(results).toEqual(expected);
    });

    it("should filter memories to only pending paths", async () => {
      const tracker = new MemoryTracker({ memoryDir: "/test" });
      const memA = makeMemoryFile({ path: "/mem/a.md" });
      const memB = makeMemoryFile({ path: "/mem/b.md" });
      const memC = makeMemoryFile({ path: "/mem/c.md" });

      mockDetectUsage.mockResolvedValue([]);

      // Only inject a and c
      tracker.recordInjection(["/mem/a.md", "/mem/c.md"]);
      await tracker.detectAndUpdate("response", [memA, memB, memC]);

      expect(mockDetectUsage).toHaveBeenCalledWith(
        "response",
        [memA, memC],
        expect.any(Object),
      );
    });

    it("should compute hitRate correctly: 0 hits / N injections = 0", async () => {
      const tracker = new MemoryTracker({ memoryDir: "/test" });
      const mem = makeMemoryFile({ path: "/mem/a.md" });

      mockDetectUsage.mockResolvedValue([
        { path: "/mem/a.md", used: false, score: 0, matchedKeywords: [] },
      ]);

      tracker.recordInjection(["/mem/a.md"]);
      await tracker.detectAndUpdate("r", [mem]);

      expect(tracker.getStats()[0]!.hitRate).toBe(0);
    });
  });

  // ── detectAndUpdateFromScan ──────────────────────────────────────────────

  describe("detectAndUpdateFromScan", () => {
    it("should delegate to detectAndUpdate with scannedFiles as memories", async () => {
      const tracker = new MemoryTracker({ memoryDir: "/test" });
      const files = makeFiles(3);

      mockDetectUsage.mockResolvedValue([
        {
          path: "/memory/file-0.md",
          used: true,
          score: 0.6,
          matchedKeywords: [],
        },
        {
          path: "/memory/file-1.md",
          used: false,
          score: 0.1,
          matchedKeywords: [],
        },
        {
          path: "/memory/file-2.md",
          used: false,
          score: 0.0,
          matchedKeywords: [],
        },
      ]);

      tracker.recordInjection(files.map((f) => f.path));
      const results = await tracker.detectAndUpdateFromScan("resp", files);

      expect(results).toHaveLength(3);
      expect(mockDetectUsage).toHaveBeenCalledWith(
        "resp",
        files,
        expect.any(Object),
      );
    });

    it("should use pendingInjection from prior recordInjection call", async () => {
      const tracker = new MemoryTracker({ memoryDir: "/test" });
      const mA = makeMemoryFile({ path: "/mem/a.md" });
      const mB = makeMemoryFile({ path: "/mem/b.md" });

      mockDetectUsage.mockResolvedValue([
        { path: "/mem/a.md", used: true, score: 0.8, matchedKeywords: [] },
      ]);

      tracker.recordInjection(["/mem/a.md"]);
      await tracker.detectAndUpdateFromScan("response", [mA, mB]);

      // Only mA should have stats (was the injected one)
      const stats = tracker.getStats();
      expect(stats).toHaveLength(1);
      expect(stats[0]!.path).toBe("/mem/a.md");
    });
  });

  // ── getStats ─────────────────────────────────────────────────────────────

  describe("getStats", () => {
    it("should return empty array when nothing tracked", () => {
      const tracker = new MemoryTracker({ memoryDir: "/test" });
      expect(tracker.getStats()).toEqual([]);
    });

    it("should return stats sorted by hitRate descending", async () => {
      const tracker = new MemoryTracker({ memoryDir: "/test" });
      const mA = makeMemoryFile({ path: "/mem/a.md" });
      const mB = makeMemoryFile({ path: "/mem/b.md" });
      const mC = makeMemoryFile({ path: "/mem/c.md" });

      // Turn 1: inject all three, only A used
      mockDetectUsage.mockResolvedValueOnce([
        { path: "/mem/a.md", used: true, score: 0.9, matchedKeywords: [] },
        { path: "/mem/b.md", used: false, score: 0.0, matchedKeywords: [] },
        { path: "/mem/c.md", used: false, score: 0.0, matchedKeywords: [] },
      ]);
      tracker.recordInjection(["/mem/a.md", "/mem/b.md", "/mem/c.md"]);
      await tracker.detectAndUpdate("r1", [mA, mB, mC]);

      // Turn 2: inject A and B, both used
      mockDetectUsage.mockResolvedValueOnce([
        { path: "/mem/a.md", used: true, score: 0.8, matchedKeywords: [] },
        { path: "/mem/b.md", used: true, score: 0.7, matchedKeywords: [] },
      ]);
      tracker.recordInjection(["/mem/a.md", "/mem/b.md"]);
      await tracker.detectAndUpdate("r2", [mA, mB]);

      const stats = tracker.getStats();
      expect(stats).toHaveLength(3);
      // A: 2/2=1.0, B: 1/2=0.5, C: 0/1=0.0
      expect(stats[0]!.path).toBe("/mem/a.md");
      expect(stats[0]!.hitRate).toBe(1.0);
      expect(stats[1]!.path).toBe("/mem/b.md");
      expect(stats[1]!.hitRate).toBe(0.5);
      expect(stats[2]!.path).toBe("/mem/c.md");
      expect(stats[2]!.hitRate).toBe(0.0);
    });
  });

  // ── getStale ────────────────────────────────────────────────────────────

  describe("getStale", () => {
    it("should return empty array when nothing tracked", () => {
      const tracker = new MemoryTracker({ memoryDir: "/test" });
      expect(tracker.getStale()).toEqual([]);
    });

    it("should return file with hitRate < 0.1 and injections >= 3", async () => {
      const tracker = new MemoryTracker({ memoryDir: "/test" });
      const mem = makeMemoryFile({ path: "/mem/a.md" });

      // 3 injections, 0 hits → hitRate=0.0 < 0.1, injections=3 >= 3 → stale
      for (let i = 0; i < 3; i++) {
        mockDetectUsage.mockResolvedValueOnce([
          {
            path: "/mem/a.md",
            used: false,
            score: 0.0,
            matchedKeywords: [],
          },
        ]);
        tracker.recordInjection(["/mem/a.md"]);
        await tracker.detectAndUpdate(`r${i}`, [mem]);
      }

      const stale = tracker.getStale();
      expect(stale).toHaveLength(1);
      expect(stale[0]!.path).toBe("/mem/a.md");
      expect(stale[0]!.hitRate).toBeLessThan(0.1);
      expect(stale[0]!.injections).toBeGreaterThanOrEqual(3);
    });

    it("should NOT return file with low hitRate but too few injections", async () => {
      const tracker = new MemoryTracker({ memoryDir: "/test" });
      const mem = makeMemoryFile({ path: "/mem/a.md" });

      // 2 injections, 0 hits → hitRate=0.0 but injections=2 < 3
      for (let i = 0; i < 2; i++) {
        mockDetectUsage.mockResolvedValueOnce([
          {
            path: "/mem/a.md",
            used: false,
            score: 0.0,
            matchedKeywords: [],
          },
        ]);
        tracker.recordInjection(["/mem/a.md"]);
        await tracker.detectAndUpdate(`r${i}`, [mem]);
      }

      expect(tracker.getStale()).toEqual([]);
    });

    it("should NOT return file with hitRate >= 0.1 even with many injections", async () => {
      const tracker = new MemoryTracker({ memoryDir: "/test" });
      const mem = makeMemoryFile({ path: "/mem/a.md" });

      // 4 injections: 1 hit, 3 misses → hitRate = 0.25 > 0.1
      mockDetectUsage.mockResolvedValueOnce([
        {
          path: "/mem/a.md",
          used: true,
          score: 0.7,
          matchedKeywords: [],
        },
      ]);
      tracker.recordInjection(["/mem/a.md"]);
      await tracker.detectAndUpdate("r-hit", [mem]);

      for (let i = 0; i < 3; i++) {
        mockDetectUsage.mockResolvedValueOnce([
          {
            path: "/mem/a.md",
            used: false,
            score: 0.0,
            matchedKeywords: [],
          },
        ]);
        tracker.recordInjection(["/mem/a.md"]);
        await tracker.detectAndUpdate(`r-miss-${i}`, [mem]);
      }

      expect(tracker.getStale()).toEqual([]);
    });

    it("should correctly handle hitRate exactly at threshold (0.1 not < 0.1)", async () => {
      const tracker = new MemoryTracker({ memoryDir: "/test" });
      const mem = makeMemoryFile({ path: "/mem/a.md" });

      // 10 injections, 1 hit → hitRate = 0.1, not < 0.1 → NOT stale
      mockDetectUsage.mockResolvedValueOnce([
        {
          path: "/mem/a.md",
          used: true,
          score: 0.5,
          matchedKeywords: [],
        },
      ]);
      tracker.recordInjection(["/mem/a.md"]);
      await tracker.detectAndUpdate("r", [mem]);

      for (let i = 0; i < 9; i++) {
        mockDetectUsage.mockResolvedValueOnce([
          {
            path: "/mem/a.md",
            used: false,
            score: 0.0,
            matchedKeywords: [],
          },
        ]);
        tracker.recordInjection(["/mem/a.md"]);
        await tracker.detectAndUpdate(`r${i}`, [mem]);
      }

      const stats = tracker.getStats();
      expect(stats[0]!.injections).toBe(10);
      expect(stats[0]!.hits).toBe(1);
      expect(stats[0]!.hitRate).toBe(0.1);

      expect(tracker.getStale()).toEqual([]);
    });

    it("should return all stale files sorted by hitRate", async () => {
      const tracker = new MemoryTracker({ memoryDir: "/test" });
      const mA = makeMemoryFile({ path: "/mem/a.md" });
      const mB = makeMemoryFile({ path: "/mem/b.md" });

      // Inject a 3 times (0 hits), b 4 times (0 hits)
      for (let i = 0; i < 3; i++) {
        mockDetectUsage.mockResolvedValueOnce([
          {
            path: "/mem/a.md",
            used: false,
            score: 0.0,
            matchedKeywords: [],
          },
        ]);
        tracker.recordInjection(["/mem/a.md"]);
        await tracker.detectAndUpdate(`r-a-${i}`, [mA]);
      }
      for (let i = 0; i < 4; i++) {
        mockDetectUsage.mockResolvedValueOnce([
          {
            path: "/mem/b.md",
            used: false,
            score: 0.0,
            matchedKeywords: [],
          },
        ]);
        tracker.recordInjection(["/mem/b.md"]);
        await tracker.detectAndUpdate(`r-b-${i}`, [mB]);
      }

      const stale = tracker.getStale();
      expect(stale).toHaveLength(2);
      // Both have 0.0 hitRate
      expect(stale[0]!.hitRate).toBeLessThan(0.1);
      expect(stale[1]!.hitRate).toBeLessThan(0.1);
    });
  });

  // ── getInjectionHistory ─────────────────────────────────────────────────

  describe("getInjectionHistory", () => {
    it("should return empty array initially", () => {
      const tracker = new MemoryTracker({ memoryDir: "/test" });
      expect(tracker.getInjectionHistory()).toEqual([]);
    });

    it("should return all injection records in order (newest first)", () => {
      const tracker = new MemoryTracker({ memoryDir: "/test" });
      tracker.recordInjection(["/mem/a.md"]);
      tracker.recordInjection(["/mem/b.md", "/mem/c.md"]);

      const history = tracker.getInjectionHistory();
      expect(history).toHaveLength(2);
      expect(history[0]!.injectedPaths).toEqual(["/mem/b.md", "/mem/c.md"]);
      expect(history[1]!.injectedPaths).toEqual(["/mem/a.md"]);
    });
  });

  // ── currentTurn ─────────────────────────────────────────────────────────

  describe("currentTurn", () => {
    it("should start at 0", () => {
      const tracker = new MemoryTracker({ memoryDir: "/test" });
      expect(tracker.currentTurn).toBe(0);
    });

    it("should reflect increment after each recordInjection", () => {
      const tracker = new MemoryTracker({ memoryDir: "/test" });
      tracker.recordInjection(["/mem/a.md"]);
      expect(tracker.currentTurn).toBe(1);

      tracker.recordInjection(["/mem/b.md"]);
      expect(tracker.currentTurn).toBe(2);

      tracker.recordInjection([]);
      expect(tracker.currentTurn).toBe(3);
    });
  });

  // ── Edge cases ───────────────────────────────────────────────────────────

  describe("edge cases", () => {
    it("should handle complete lifecycle: scan → select → inject → detect", async () => {
      const tracker = new MemoryTracker({
        memoryDir: "/test",
        maxInjectPerTurn: 3,
      });

      const allFiles = makeFiles(5);
      mockScanMemoryDir.mockResolvedValue(allFiles);

      const files = await tracker.scan();
      const selected = tracker.selectForInjection(files);
      expect(selected).toHaveLength(3);

      tracker.recordInjection(selected.map((f) => f.path));
      mockDetectUsage.mockResolvedValueOnce(
        selected.map((f, i) => ({
          path: f.path,
          used: i === 0,
          score: i === 0 ? 0.8 : 0.05,
          matchedKeywords: [],
        })),
      );
      await tracker.detectAndUpdate("t1 response", files);

      expect(tracker.currentTurn).toBe(1);
      expect(tracker.getStats()).toHaveLength(3);
      expect(tracker.getInjectionHistory()).toHaveLength(1);
    });

    it("should handle scan returning empty results", async () => {
      const tracker = new MemoryTracker({ memoryDir: "/test" });
      mockScanMemoryDir.mockResolvedValue([]);

      const files = await tracker.scan();
      const selected = tracker.selectForInjection(files);
      expect(selected).toEqual([]);

      tracker.recordInjection([]);
      mockDetectUsage.mockResolvedValue([]);
      await tracker.detectAndUpdate("r", []);

      expect(tracker.getStats()).toEqual([]);
      expect(tracker.currentTurn).toBe(1);
    });

    it("should handle zero maxInjectPerTurn", () => {
      const tracker = new MemoryTracker({
        memoryDir: "/test",
        maxInjectPerTurn: 0,
      });
      const files = makeFiles(5);
      expect(tracker.selectForInjection(files)).toEqual([]);
    });

    it("should handle recordInjection with empty paths array", () => {
      const tracker = new MemoryTracker({ memoryDir: "/test" });
      tracker.recordInjection([]);

      expect(tracker.currentTurn).toBe(1);
      expect(tracker.getInjectionHistory()).toHaveLength(1);
      expect(tracker.getInjectionHistory()[0]!.injectedPaths).toEqual([]);
      expect(tracker.getStats()).toEqual([]);
    });

    it("should handle recordInjection with duplicate paths", () => {
      const tracker = new MemoryTracker({ memoryDir: "/test" });
      tracker.recordInjection(["/mem/a.md", "/mem/a.md"]);

      const history = tracker.getInjectionHistory();
      expect(history[0]!.injectedPaths).toEqual(["/mem/a.md", "/mem/a.md"]);

      // Stats should have only one entry (Set-like behavior from Map)
      expect(tracker.getStats()).toHaveLength(1);
    });

    it("should preserve lastScore as most recent detection score", async () => {
      const tracker = new MemoryTracker({ memoryDir: "/test" });
      const mem = makeMemoryFile({ path: "/mem/a.md" });

      mockDetectUsage.mockResolvedValueOnce([
        { path: "/mem/a.md", used: true, score: 0.95, matchedKeywords: [] },
      ]);
      tracker.recordInjection(["/mem/a.md"]);
      await tracker.detectAndUpdate("r1", [mem]);

      mockDetectUsage.mockResolvedValueOnce([
        { path: "/mem/a.md", used: false, score: 0.01, matchedKeywords: [] },
      ]);
      tracker.recordInjection(["/mem/a.md"]);
      await tracker.detectAndUpdate("r2", [mem]);

      expect(tracker.getStats()[0]!.lastScore).toBe(0.01); // most recent
    });

    it("should handle detectAndUpdate with empty memory array when paths were injected", async () => {
      const tracker = new MemoryTracker({ memoryDir: "/test" });
      const mem = makeMemoryFile({ path: "/mem/a.md" });

      mockDetectUsage.mockResolvedValue([]);

      tracker.recordInjection(["/mem/a.md"]);
      // Pass empty memories array; filter yields empty
      await tracker.detectAndUpdate("response", []);

      expect(mockDetectUsage).toHaveBeenCalledWith(
        "response",
        [],
        expect.any(Object),
      );

      // Stats should exist (initialized by recordInjection) but injections=0
      const stats = tracker.getStats();
      expect(stats).toHaveLength(1);
      expect(stats[0]!.injections).toBe(0);
    });

    it("should track many files across turns correctly", async () => {
      const tracker = new MemoryTracker({
        memoryDir: "/test",
        maxInjectPerTurn: 10,
      });
      const files = makeFiles(8);

      mockDetectUsage.mockResolvedValue(
        files.map((f, i) => ({
          path: f.path,
          used: i < 4, // first 4 used
          score: i < 4 ? 0.6 : 0.0,
          matchedKeywords: [],
        })),
      );

      tracker.recordInjection(files.map((f) => f.path));
      await tracker.detectAndUpdate("response", files);

      const stats = tracker.getStats();
      expect(stats).toHaveLength(8);
      expect(stats.filter((s) => s.hits > 0)).toHaveLength(4);
      expect(tracker.getStale()).toEqual([]); // < 3 injections
    });
  });
});
