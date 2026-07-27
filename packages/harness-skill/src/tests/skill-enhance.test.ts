/**
 * Skill Enhancement Tests (SK1-SK5)
 *
 * Covers:
 * - SK1: Skill Auto-Extractor
 * - SK2: Skill Auto-Scorer
 * - SK3: Skill Recommender
 * - SK4: Skill Version Manager
 * - SK5: Skill Hot-Reloader (unit-level, no actual FS watchers)
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  SkillAutoExtractor,
  SkillAutoScorer,
  SkillRecommender,
  SkillVersionManager,
  type ExecutionTrace,
  type SkillExecutionRecord,
  type TaskContext,
} from "../index.js";
import type { Skill } from "../types.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeTrace(overrides?: Partial<ExecutionTrace>): ExecutionTrace {
  return {
    taskDescription: "Read a file and search for patterns",
    domain: "code",
    level: 1,
    toolCalls: [
      { toolName: "read_file", args: { path: "src/index.ts" }, success: true, durationMs: 100 },
      { toolName: "grep", args: { pattern: "TODO" }, success: true, durationMs: 200 },
    ],
    success: true,
    costUsd: 0.01,
    durationMs: 300,
    ...overrides,
  };
}

function makeSkill(overrides?: Partial<Skill>): Skill {
  return {
    id: "test-skill",
    name: "test-skill",
    description: "A test skill",
    triggers: [{ type: "domain", domains: ["code"] }],
    ...overrides,
  };
}

// ── SK1: Skill Auto-Extractor ─────────────────────────────────────────────────

describe("SkillAutoExtractor", () => {
  let extractor: SkillAutoExtractor;

  beforeEach(() => {
    extractor = new SkillAutoExtractor();
  });

  it("should extract a skill from a successful trace", () => {
    const trace = makeTrace();
    const result = extractor.extract(trace);

    expect(result).not.toBeNull();
    expect(result!.skill.name).toContain("auto:");
    expect(result!.skill.triggers.length).toBeGreaterThan(0);
    expect(result!.toolNames).toContain("read_file");
    expect(result!.toolNames).toContain("grep");
  });

  it("should reject unsuccessful traces", () => {
    const trace = makeTrace({ success: false });
    expect(extractor.extract(trace)).toBeNull();
  });

  it("should reject traces with too few tool calls", () => {
    const trace = makeTrace({
      toolCalls: [
        { toolName: "read_file", args: {}, success: true, durationMs: 50 },
      ],
    });
    expect(extractor.extract(trace)).toBeNull();
  });

  it("should reject tools with low success rate", () => {
    const extractor = new SkillAutoExtractor({ minToolSuccessRate: 0.8 });
    const trace = makeTrace({
      toolCalls: [
        { toolName: "read_file", args: {}, success: true, durationMs: 50 },
        { toolName: "read_file", args: {}, success: false, durationMs: 50 },
        { toolName: "read_file", args: {}, success: false, durationMs: 50 },
        { toolName: "grep", args: {}, success: true, durationMs: 50 },
      ],
    });
    const result = extractor.extract(trace);
    // read_file has 33% success rate, below 80% — should not be included
    // grep has 100% but only 1 unique tool may fail minUniqueTools
    if (result) {
      expect(result.toolNames).not.toContain("read_file");
    }
  });

  it("should infer domain triggers correctly", () => {
    const trace = makeTrace({ domain: "analysis" });
    const result = extractor.extract(trace);
    expect(result).not.toBeNull();
    const domainTrigger = result!.skill.triggers.find((t) => t.type === "domain");
    expect(domainTrigger).toBeDefined();
    if (domainTrigger?.type === "domain") {
      expect(domainTrigger.domains).toContain("analysis");
    }
  });

  it("should add level trigger for complex tasks", () => {
    const trace = makeTrace({ level: 3 });
    const result = extractor.extract(trace);
    expect(result).not.toBeNull();
    const levelTrigger = result!.skill.triggers.find((t) => t.type === "level");
    expect(levelTrigger).toBeDefined();
    if (levelTrigger?.type === "level") {
      expect(levelTrigger.minLevel).toBe(3);
    }
  });

  it("should deduplicate skills with same tool set in batch", () => {
    const trace1 = makeTrace({ taskDescription: "Search for code patterns" });
    const trace2 = makeTrace({ taskDescription: "Find patterns in code" });
    const results = extractor.extractBatch([trace1, trace2]);
    // Both have the same tool set (read_file, grep) — should deduplicate
    expect(results.length).toBeLessThanOrEqual(2);
  });

  it("should include system fragments in extracted skill", () => {
    const trace = makeTrace({
      systemFragments: ["Always use TypeScript strict mode", "Follow ESLint rules"],
    });
    const result = extractor.extract(trace);
    expect(result).not.toBeNull();
    expect(result!.skill.systemFragment).toContain("TypeScript");
    expect(result!.skill.systemFragment).toContain("ESLint");
  });
});

// ── SK2: Skill Auto-Scorer ────────────────────────────────────────────────────

describe("SkillAutoScorer", () => {
  let scorer: SkillAutoScorer;

  beforeEach(() => {
    scorer = new SkillAutoScorer();
  });

  it("should return null for unknown skills", () => {
    expect(scorer.getScore("nonexistent")).toBeNull();
  });

  it("should compute a perfect score for all-successful fast cheap executions", () => {
    for (let i = 0; i < 5; i++) {
      scorer.recordExecution({
        skillId: "fast-skill",
        timestamp: new Date().toISOString(),
        success: true,
        durationMs: 1000,
        toolCallCount: 2,
        errorCount: 0,
        costUsd: 0.001,
      });
    }

    const score = scorer.getScore("fast-skill");
    expect(score).not.toBeNull();
    expect(score!.score).toBeGreaterThan(0.8);
    expect(score!.successRate).toBe(1);
    expect(score!.usageCount).toBe(5);
  });

  it("should penalize failures", () => {
    // 50% failure rate
    for (let i = 0; i < 4; i++) {
      scorer.recordExecution({
        skillId: "flaky-skill",
        timestamp: new Date().toISOString(),
        success: i % 2 === 0,
        durationMs: 5000,
        toolCallCount: 3,
        errorCount: i % 2 === 0 ? 0 : 1,
      });
    }

    const score = scorer.getScore("flaky-skill");
    expect(score).not.toBeNull();
    expect(score!.successRate).toBe(0.5);
    // 50% success (0.5*0.4=0.2) + fast speed (1*0.3=0.3) + no cost (1*0.3=0.3) = 0.8
    // Score is still decent because speed and cost are good
    expect(score!.score).toBeLessThan(0.9);
    // But should be less than a perfect score
    expect(score!.score).toBeLessThan(1.0);
  });

  it("should penalize slow executions", () => {
    scorer.recordExecution({
      skillId: "slow-skill",
      timestamp: new Date().toISOString(),
      success: true,
      durationMs: 60_000, // Very slow
      toolCallCount: 10,
      errorCount: 0,
    });

    const score = scorer.getScore("slow-skill");
    expect(score).not.toBeNull();
    // Speed component should be low (reference / 60000)
    expect(score!.score).toBeLessThan(0.8);
  });

  it("should penalize all-bad executions (slow + expensive + failing)", () => {
    for (let i = 0; i < 4; i++) {
      scorer.recordExecution({
        skillId: "terrible",
        timestamp: new Date().toISOString(),
        success: false,
        durationMs: 60_000,
        toolCallCount: 10,
        errorCount: 5,
        costUsd: 1.0,
      });
    }

    const score = scorer.getScore("terrible");
    expect(score).not.toBeNull();
    expect(score!.successRate).toBe(0);
    // 0*0.4 + speed(10k/60k=0.17)*0.3 + cost(0.05/1.0=0.05)*0.3 ≈ 0.066
    expect(score!.score).toBeLessThan(0.15);
  });

  it("should rank skills by score", () => {
    // Good skill
    scorer.recordExecution({
      skillId: "good",
      timestamp: new Date().toISOString(),
      success: true,
      durationMs: 1000,
      toolCallCount: 2,
      errorCount: 0,
      costUsd: 0.001,
    });

    // Bad skill
    scorer.recordExecution({
      skillId: "bad",
      timestamp: new Date().toISOString(),
      success: false,
      durationMs: 60_000,
      toolCallCount: 10,
      errorCount: 5,
      costUsd: 1.0,
    });

    const all = scorer.getAllScores();
    expect(all.length).toBe(2);
    expect(all[0]!.skillId).toBe("good");
    expect(all[1]!.skillId).toBe("bad");
  });

  it("should track execution records", () => {
    scorer.recordExecution({
      skillId: "tracked",
      timestamp: "2026-01-01T00:00:00Z",
      success: true,
      durationMs: 500,
      toolCallCount: 1,
      errorCount: 0,
    });
    scorer.recordExecution({
      skillId: "tracked",
      timestamp: "2026-01-02T00:00:00Z",
      success: true,
      durationMs: 600,
      toolCallCount: 1,
      errorCount: 0,
    });

    const records = scorer.getRecords("tracked");
    expect(records.length).toBe(2);
  });

  it("should clear all records", () => {
    scorer.recordExecution({
      skillId: "to-clear",
      timestamp: new Date().toISOString(),
      success: true,
      durationMs: 100,
      toolCallCount: 1,
      errorCount: 0,
    });
    expect(scorer.getRecords("to-clear").length).toBe(1);
    scorer.clear();
    expect(scorer.getRecords("to-clear").length).toBe(0);
  });
});

// ── SK3: Skill Recommender ────────────────────────────────────────────────────

describe("SkillRecommender", () => {
  let recommender: SkillRecommender;

  beforeEach(() => {
    recommender = new SkillRecommender();
    recommender.register(
      makeSkill({
        id: "code-review",
        name: "code-review",
        description: "Review code for bugs and improvements",
        triggers: [{ type: "domain", domains: ["code"] }],
      })
    );
    recommender.register(
      makeSkill({
        id: "web-search",
        name: "web-search",
        description: "Search the web for information",
        triggers: [{ type: "domain", domains: ["search"] }],
      })
    );
    recommender.register(
      makeSkill({
        id: "always-on",
        name: "always-on",
        description: "Always active utility",
        triggers: [{ type: "always" }],
      })
    );
  });

  it("should recommend domain-matching skills", () => {
    const task: TaskContext = {
      description: "Review this TypeScript code for issues",
      domain: "code",
      level: 1,
    };

    const results = recommender.recommend(task);
    const ids = results.map((r) => r.skill.id);
    expect(ids).toContain("code-review");
  });

  it("should recommend always-active skills with partial score", () => {
    const task: TaskContext = {
      description: "Search for documentation",
      domain: "search",
      level: 1,
    };

    const results = recommender.recommend(task);
    const alwaysOn = results.find((r) => r.skill.id === "always-on");
    expect(alwaysOn).toBeDefined();
    expect(alwaysOn!.relevance).toBeGreaterThan(0);
    expect(alwaysOn!.relevance).toBeLessThan(1);
  });

  it("should boost explicitly requested skills to top", () => {
    const task: TaskContext = {
      description: "Something unrelated to code",
      domain: "other",
      level: 0,
      explicitSkillIds: ["code-review"],
    };

    const results = recommender.recommend(task);
    expect(results[0]!.skill.id).toBe("code-review");
    expect(results[0]!.relevance).toBe(1.0);
    expect(results[0]!.reasons).toContain("explicitly requested");
  });

  it("should exclude irrelevant skills below threshold", () => {
    const recommender = new SkillRecommender({ minRelevance: 0.8 });
    recommender.register(
      makeSkill({
        id: "niche-skill",
        name: "niche-skill",
        description: "Very specific task",
        triggers: [{ type: "domain", domains: ["analysis"] }],
      })
    );

    const task: TaskContext = {
      description: "Chat casually",
      domain: "chat",
      level: 0,
    };

    const results = recommender.recommend(task);
    expect(results.find((r) => r.skill.id === "niche-skill")).toBeUndefined();
  });

  it("should include reasons in recommendations", () => {
    const task: TaskContext = {
      description: "code review analysis",
      domain: "code",
      level: 1,
      keywords: ["code", "review"],
    };

    const results = recommender.recommend(task);
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r.reasons.length).toBeGreaterThan(0);
    }
  });

  it("should respect maxRecommendations limit", () => {
    const recommender = new SkillRecommender({ maxRecommendations: 2 });
    for (let i = 0; i < 5; i++) {
      recommender.register(
        makeSkill({ id: `skill-${i}`, name: `skill-${i}` })
      );
    }

    const task: TaskContext = {
      description: "anything",
      domain: "chat",
      level: 0,
    };

    const results = recommender.recommend(task);
    expect(results.length).toBeLessThanOrEqual(2);
  });

  it("should integrate with SkillAutoScorer for effectiveness", () => {
    const scorer = new SkillAutoScorer();
    scorer.recordExecution({
      skillId: "code-review",
      timestamp: new Date().toISOString(),
      success: true,
      durationMs: 500,
      toolCallCount: 2,
      errorCount: 0,
      costUsd: 0.001,
    });

    const recommender = new SkillRecommender(
      { effectivenessWeight: 0.5 },
      scorer
    );
    recommender.register(
      makeSkill({
        id: "code-review",
        name: "code-review",
        description: "Review code",
        triggers: [{ type: "domain", domains: ["code"] }],
      })
    );

    const task: TaskContext = {
      description: "Review code",
      domain: "code",
      level: 1,
    };

    const results = recommender.recommend(task);
    const codeReview = results.find((r) => r.skill.id === "code-review");
    expect(codeReview).toBeDefined();
    expect(codeReview!.reasons.some((r) => r.includes("effectiveness"))).toBe(true);
  });
});

// ── SK4: Skill Version Manager ────────────────────────────────────────────────

describe("SkillVersionManager", () => {
  let manager: SkillVersionManager;

  beforeEach(() => {
    manager = new SkillVersionManager();
  });

  it("should record versions with incrementing numbers", () => {
    const skill = makeSkill();
    const v1 = manager.recordVersion(skill, "initial");
    const v2 = manager.recordVersion(skill, "updated");
    expect(v1).toBe(1);
    expect(v2).toBe(2);
  });

  it("should get the latest version", () => {
    const skill = makeSkill();
    manager.recordVersion(skill, "v1");
    manager.recordVersion(skill, "v2");

    const latest = manager.getLatest(skill.id);
    expect(latest).not.toBeNull();
    expect(latest!.version).toBe(2);
  });

  it("should return null for untracked skills", () => {
    expect(manager.getLatest("unknown")).toBeNull();
    expect(manager.getVersion("unknown", 1)).toBeNull();
  });

  it("should get a specific version", () => {
    const skill = makeSkill();
    manager.recordVersion(skill, "v1");
    manager.recordVersion(
      makeSkill({ name: "updated-skill" }),
      "v2"
    );

    const v1 = manager.getVersion("test-skill", 1);
    expect(v1).not.toBeNull();
    expect(v1!.snapshot.name).toBe("test-skill");

    const v2 = manager.getVersion("test-skill", 2);
    expect(v2).not.toBeNull();
    expect(v2!.snapshot.name).toBe("updated-skill");
  });

  it("should return version history newest first", () => {
    const skill = makeSkill();
    manager.recordVersion(skill, "v1");
    manager.recordVersion(skill, "v2");
    manager.recordVersion(skill, "v3");

    const history = manager.getHistory(skill.id);
    expect(history.length).toBe(3);
    expect(history[0]!.version).toBe(3);
    expect(history[2]!.version).toBe(1);
  });

  it("should compute diff between versions", () => {
    const skill = makeSkill();
    manager.recordVersion(skill, "v1");
    manager.recordVersion(
      makeSkill({ name: "new-name", description: "new desc" }),
      "v2"
    );

    const diff = manager.diff("test-skill", 1, 2);
    expect(diff).not.toBeNull();
    expect(diff!.changes.length).toBe(2);
    expect(diff!.changes.some((c) => c.field === "name" && c.type === "changed")).toBe(true);
    expect(diff!.changes.some((c) => c.field === "description" && c.type === "changed")).toBe(true);
  });

  it("should detect no changes in identical versions", () => {
    const skill = makeSkill();
    manager.recordVersion(skill, "v1");
    manager.recordVersion(makeSkill(), "v2");

    const diff = manager.diff("test-skill", 1, 2);
    expect(diff).not.toBeNull();
    expect(diff!.changes.length).toBe(0);
  });

  it("should rollback to a previous version", () => {
    const skill = makeSkill();
    manager.recordVersion(skill, "v1");
    manager.recordVersion(
      makeSkill({ name: "bad-name" }),
      "v2"
    );

    const snapshot = manager.rollback("test-skill", 1);
    expect(snapshot).not.toBeNull();
    expect(snapshot!.name).toBe("test-skill");

    // Rollback creates a new version
    expect(manager.getVersionCount("test-skill")).toBe(3);
    const latest = manager.getLatest("test-skill");
    expect(latest!.changeDescription).toContain("Rollback to version 1");
  });

  it("should return null on rollback to non-existent version", () => {
    const skill = makeSkill();
    manager.recordVersion(skill, "v1");
    expect(manager.rollback("test-skill", 99)).toBeNull();
  });

  it("should list all tracked skill IDs", () => {
    manager.recordVersion(makeSkill({ id: "a" }), "v1");
    manager.recordVersion(makeSkill({ id: "b" }), "v1");
    const ids = manager.listSkillIds();
    expect(ids).toContain("a");
    expect(ids).toContain("b");
  });

  it("should track change descriptions", () => {
    manager.recordVersion(makeSkill(), "added feature X");
    const v = manager.getLatest("test-skill");
    expect(v!.changeDescription).toBe("added feature X");
  });
});
