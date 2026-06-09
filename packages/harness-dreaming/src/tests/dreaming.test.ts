/**
 * Tests for Dreaming system (DR1-DR5).
 * Covers: DreamingRunner, DreamingScheduler.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DreamingRunner } from "../runner.js";
import { DreamingScheduler } from "../scheduler.js";
import type { Experience } from "../runner.js";

// ── Test Data ────────────────────────────────────────────────────────────────

function makeExperience(overrides: Partial<Experience> = {}): Experience {
  return {
    id: `exp-${Math.random().toString(36).slice(2, 8)}`,
    type: "success",
    taskDescription: "Test task",
    toolCalls: ["read_file"],
    duration: 1000,
    outcome: "Completed successfully",
    ...overrides,
  };
}

const successExperiences: Experience[] = [
  makeExperience({ id: "s1", type: "success", toolCalls: ["grep", "read_file"], duration: 800 }),
  makeExperience({ id: "s2", type: "success", toolCalls: ["grep", "read_file"], duration: 900 }),
  makeExperience({ id: "s3", type: "success", toolCalls: ["grep", "read_file"], duration: 700 }),
];

const failureExperiences: Experience[] = [
  makeExperience({ id: "f1", type: "failure", toolCalls: ["bash"], outcome: "Permission denied", duration: 2000 }),
  makeExperience({ id: "f2", type: "failure", toolCalls: ["bash"], outcome: "Timeout", duration: 5000 }),
  makeExperience({ id: "f3", type: "failure", toolCalls: ["bash"], outcome: "Command not found", duration: 1500 }),
];

const mixedExperiences: Experience[] = [...successExperiences, ...failureExperiences];

// ── DreamingRunner Tests ────────────────────────────────────────────────────

describe("DreamingRunner", () => {
  it("should extract success patterns", async () => {
    const runner = new DreamingRunner();
    const result = await runner.dream(successExperiences);

    expect(result.insights.length).toBeGreaterThan(0);
    const patterns = result.insights.filter((i) => i.category === "pattern");
    expect(patterns.length).toBeGreaterThan(0);
    expect(patterns[0].description).toContain("succeeds");
  });

  it("should extract failure anti-patterns", async () => {
    const runner = new DreamingRunner();
    const result = await runner.dream(failureExperiences);

    const antiPatterns = result.insights.filter((i) => i.category === "anti_pattern");
    expect(antiPatterns.length).toBeGreaterThan(0);
    expect(antiPatterns[0].description).toContain("fails");
  });

  it("should detect slow tasks", async () => {
    const experiences = [
      makeExperience({ duration: 100 }),
      makeExperience({ duration: 100 }),
      makeExperience({ duration: 100 }),
      makeExperience({ duration: 5000 }), // very slow
    ];

    const runner = new DreamingRunner();
    const result = await runner.dream(experiences);

    const optimizations = result.insights.filter((i) => i.category === "optimization");
    expect(optimizations.length).toBeGreaterThan(0);
  });

  it("should generate proposals from insights", async () => {
    const runner = new DreamingRunner();
    const result = await runner.dream(mixedExperiences);

    expect(result.proposals.length).toBeGreaterThan(0);
    expect(result.proposals.every((p) => p.id && p.title && p.description)).toBe(true);
  });

  it("should respect maxProposals config", async () => {
    const runner = new DreamingRunner({ maxProposals: 2 });
    const result = await runner.dream(mixedExperiences);

    expect(result.proposals.length).toBeLessThanOrEqual(2);
  });

  it("should filter by minConfidence", async () => {
    const runner = new DreamingRunner({ minConfidence: 0.95 });
    const result = await runner.dream(mixedExperiences);

    expect(result.insights.every((i) => i.confidence >= 0.95)).toBe(true);
  });

  it("should respect proposalTypes filter", async () => {
    const runner = new DreamingRunner({ proposalTypes: ["skill"] });
    const result = await runner.dream(mixedExperiences);

    expect(result.proposals.every((p) => p.type === "skill")).toBe(true);
  });

  it("should handle empty experiences", async () => {
    const runner = new DreamingRunner();
    const result = await runner.dream([]);

    expect(result.insights).toEqual([]);
    expect(result.proposals).toEqual([]);
    expect(result.experiencesAnalyzed).toBe(0);
  });

  it("should track analysis duration", async () => {
    const runner = new DreamingRunner();
    const result = await runner.dream(mixedExperiences);

    expect(result.duration).toBeGreaterThanOrEqual(0);
  });

  it("should limit analyzed experiences", async () => {
    const many = Array.from({ length: 200 }, (_, i) =>
      makeExperience({ id: `many-${i}`, type: "success", toolCalls: ["bash"] }),
    );

    const runner = new DreamingRunner({ maxExperiences: 10 });
    const result = await runner.dream(many);

    expect(result.experiencesAnalyzed).toBe(10);
  });
});

// ── DreamingScheduler Tests ─────────────────────────────────────────────────

describe("DreamingScheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should trigger dreaming after idle threshold", async () => {
    let completed = false;
    const experiences = Array.from({ length: 10 }, () => makeExperience());

    const scheduler = new DreamingScheduler(() => experiences, {
      idleThresholdMs: 5000,
      onComplete: () => { completed = true; },
    });

    scheduler.start();

    // Not yet - still within idle threshold
    vi.advanceTimersByTime(3000);
    expect(completed).toBe(false);

    // After threshold - dreaming should trigger
    vi.advanceTimersByTime(3000);
    // Give async dreaming time to complete
    await vi.runAllTimersAsync();
    expect(completed).toBe(true);
  });

  it("should not trigger with too few experiences", async () => {
    let completed = false;
    const experiences = [makeExperience()]; // only 1

    const scheduler = new DreamingScheduler(() => experiences, {
      idleThresholdMs: 1000,
      minExperiences: 5,
      onComplete: () => { completed = true; },
    });

    scheduler.start();
    vi.advanceTimersByTime(2000);
    await vi.runAllTimersAsync();

    expect(completed).toBe(false);
  });

  it("should interrupt dreaming on activity", async () => {
    let interrupted = false;
    const experiences = Array.from({ length: 10 }, () => makeExperience());

    const scheduler = new DreamingScheduler(() => experiences, {
      idleThresholdMs: 1000,
      onInterrupt: () => { interrupted = true; },
    });

    scheduler.start();
    vi.advanceTimersByTime(1500); // trigger dreaming

    // Simulate activity during dreaming
    scheduler.notifyActivity();
    expect(interrupted).toBe(true);
  });

  it("should reset idle timer on activity", async () => {
    let completed = false;
    const experiences = Array.from({ length: 10 }, () => makeExperience());

    const scheduler = new DreamingScheduler(() => experiences, {
      idleThresholdMs: 5000,
      onComplete: () => { completed = true; },
    });

    scheduler.start();
    vi.advanceTimersByTime(3000);
    scheduler.notifyActivity(); // reset timer
    vi.advanceTimersByTime(3000); // 3s after reset, not yet 5s

    expect(completed).toBe(false);
  });

  it("should stop cleanly", () => {
    const experiences = Array.from({ length: 10 }, () => makeExperience());
    const scheduler = new DreamingScheduler(() => experiences, {
      idleThresholdMs: 1000,
    });

    scheduler.start();
    scheduler.stop();

    // Should not throw or leak timers
    vi.advanceTimersByTime(5000);
  });

  it("should manually trigger dreaming", async () => {
    const experiences = Array.from({ length: 10 }, () => makeExperience());
    const scheduler = new DreamingScheduler(() => experiences, {
      minExperiences: 5,
    });

    const result = await scheduler.triggerDream();
    expect(result).not.toBeNull();
    expect(result!.experiencesAnalyzed).toBe(10);
  });

  it("should return null for manual trigger with too few experiences", async () => {
    const experiences = [makeExperience()];
    const scheduler = new DreamingScheduler(() => experiences, {
      minExperiences: 5,
    });

    const result = await scheduler.triggerDream();
    expect(result).toBeNull();
  });

  it("should report idle time", () => {
    const experiences: Experience[] = [];
    const scheduler = new DreamingScheduler(() => experiences);

    vi.advanceTimersByTime(5000);
    expect(scheduler.getIdleTimeMs()).toBeGreaterThanOrEqual(5000);
  });
});
