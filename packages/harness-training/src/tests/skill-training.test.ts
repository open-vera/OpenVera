/**
 * Tests for Skill Pre-training modules (SP1-SP7).
 * Covers: SkillOptAdapter, DataPreparer, Trainer, TrainingEvalRunner, SkillImporter.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DataPreparer } from "../data-preparer.js";
import { SkillImporter } from "../skill-importer.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeTmpDir(name: string): string {
  return mkdtempSync(join(tmpdir(), `skill-training-test-${name}-`));
}

function cleanup(dir: string): void {
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}

// ── DataPreparer Tests ──────────────────────────────────────────────────────

describe("DataPreparer", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir("preparer");
  });

  afterEach(() => cleanup(tmpDir));

  it("should load vera-custom format", () => {
    const cases = [
      { id: "c1", prompt: "What is 2+2?", expected: "4", description: "math", level: 1, evalType: "exact" },
      { id: "c2", prompt: "Read file", expected: "contents", description: "file", level: 1, evalType: "contains" },
    ];
    const sourcePath = join(tmpDir, "cases.json");
    writeFileSync(sourcePath, JSON.stringify(cases), "utf-8");

    const preparer = new DataPreparer();
    const result = preparer.prepare({
      sourcePath,
      outputDir: join(tmpDir, "output"),
      format: "vera-custom",
    });

    expect(result.totalSamples).toBe(2);
    expect(result.trainCount).toBeGreaterThan(0);
    expect(result.format).toBe("vera-custom");
  });

  it("should create train/val/test directories", () => {
    const cases = Array.from({ length: 100 }, (_, i) => ({
      id: `c${i}`,
      prompt: `Question ${i}`,
      expected: `Answer ${i}`,
    }));
    const sourcePath = join(tmpDir, "cases.json");
    writeFileSync(sourcePath, JSON.stringify(cases), "utf-8");

    const outputDir = join(tmpDir, "split-output");
    const preparer = new DataPreparer();
    preparer.prepare({ sourcePath, outputDir, format: "vera-custom" });

    expect(existsSync(join(outputDir, "train", "data.json"))).toBe(true);
    expect(existsSync(join(outputDir, "val", "data.json"))).toBe(true);
    expect(existsSync(join(outputDir, "test", "data.json"))).toBe(true);
  });

  it("should respect custom split ratios", () => {
    const cases = Array.from({ length: 100 }, (_, i) => ({
      id: `c${i}`,
      prompt: `Q${i}`,
      expected: `A${i}`,
    }));
    const sourcePath = join(tmpDir, "cases.json");
    writeFileSync(sourcePath, JSON.stringify(cases), "utf-8");

    const preparer = new DataPreparer();
    const result = preparer.prepare({
      sourcePath,
      outputDir: join(tmpDir, "custom-split"),
      format: "vera-custom",
      splitRatio: { train: 0.6, val: 0.2, test: 0.2 },
    });

    expect(result.trainCount).toBe(60);
    expect(result.valCount).toBe(20);
    expect(result.testCount).toBe(20);
  });

  it("should reject invalid split ratios", () => {
    const preparer = new DataPreparer();
    const sourcePath = join(tmpDir, "empty.json");
    writeFileSync(sourcePath, "[]", "utf-8");

    expect(() =>
      preparer.prepare({
        sourcePath,
        outputDir: join(tmpDir, "bad-split"),
        format: "vera-custom",
        splitRatio: { train: 0.5, val: 0.3, test: 0.3 },
      }),
    ).toThrow("Split ratios must sum to 1");
  });

  it("should respect maxSamples limit", () => {
    const cases = Array.from({ length: 50 }, (_, i) => ({
      id: `c${i}`,
      prompt: `Q${i}`,
      expected: `A${i}`,
    }));
    const sourcePath = join(tmpDir, "cases.json");
    writeFileSync(sourcePath, JSON.stringify(cases), "utf-8");

    const preparer = new DataPreparer();
    const result = preparer.prepare({
      sourcePath,
      outputDir: join(tmpDir, "limited"),
      format: "vera-custom",
      maxSamples: 10,
    });

    expect(result.totalSamples).toBe(10);
  });

  it("should produce reproducible splits with same seed", () => {
    const cases = Array.from({ length: 50 }, (_, i) => ({
      id: `c${i}`,
      prompt: `Q${i}`,
      expected: `A${i}`,
    }));
    const sourcePath = join(tmpDir, "cases.json");
    writeFileSync(sourcePath, JSON.stringify(cases), "utf-8");

    const preparer = new DataPreparer();

    const r1 = preparer.prepare({
      sourcePath,
      outputDir: join(tmpDir, "seed-a"),
      format: "vera-custom",
      seed: 42,
    });

    const r2 = preparer.prepare({
      sourcePath,
      outputDir: join(tmpDir, "seed-b"),
      format: "vera-custom",
      seed: 42,
    });

    const train1 = JSON.parse(readFileSync(join(tmpDir, "seed-a", "train", "data.json"), "utf-8")) as Array<{ id: string }>;
    const train2 = JSON.parse(readFileSync(join(tmpDir, "seed-b", "train", "data.json"), "utf-8")) as Array<{ id: string }>;

    expect(train1.map((s) => s.id)).toEqual(train2.map((s) => s.id));
  });

  it("should load JSONL format", () => {
    const lines = [
      JSON.stringify({ id: "j1", input: "What?", output: "Yes" }),
      JSON.stringify({ id: "j2", input: "How?", output: "Like this" }),
    ];
    const sourcePath = join(tmpDir, "data.jsonl");
    writeFileSync(sourcePath, lines.join("\n"), "utf-8");

    const preparer = new DataPreparer();
    const result = preparer.prepare({
      sourcePath,
      outputDir: join(tmpDir, "jsonl-out"),
      format: "searchqa",
    });

    expect(result.totalSamples).toBe(2);
  });

  it("should handle empty source gracefully", () => {
    const sourcePath = join(tmpDir, "empty.json");
    writeFileSync(sourcePath, "[]", "utf-8");

    const preparer = new DataPreparer();
    const result = preparer.prepare({
      sourcePath,
      outputDir: join(tmpDir, "empty-out"),
      format: "vera-custom",
    });

    expect(result.totalSamples).toBe(0);
    expect(result.trainCount).toBe(0);
  });

  it("should load directory of JSON files for generic formats", () => {
    const dataDir = join(tmpDir, "qa-files");
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, "q1.json"), JSON.stringify({ id: "q1", input: "What?", output: "Yes" }));
    writeFileSync(join(dataDir, "q2.json"), JSON.stringify({ id: "q2", input: "How?", output: "This way" }));

    const preparer = new DataPreparer();
    const result = preparer.prepare({
      sourcePath: dataDir,
      outputDir: join(tmpDir, "dir-out"),
      format: "docvqa",
    });

    expect(result.totalSamples).toBe(2);
  });
});

// ── SkillImporter Tests ─────────────────────────────────────────────────────

describe("SkillImporter", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir("importer");
  });

  afterEach(() => cleanup(tmpDir));

  it("should import a skill file", () => {
    const skillPath = join(tmpDir, "best_skill.md");
    writeFileSync(skillPath, "# Best Skill\n\nDo the thing well.", "utf-8");

    const importer = new SkillImporter();
    const result = importer.import({
      skillPath,
      targetDir: join(tmpDir, "skills"),
      name: "test-skill",
      description: "A test skill",
    });

    expect(existsSync(result.skillMdPath)).toBe(true);
    expect(existsSync(result.metadataPath)).toBe(true);
    expect(result.metadata.name).toBe("test-skill");
    expect(result.metadata.version).toBe(1);
    expect(result.metadata.tags).toContain("trained");
  });

  it("should include frontmatter in SKILL.md", () => {
    const skillPath = join(tmpDir, "best_skill.md");
    writeFileSync(skillPath, "## Instructions\n\nDo stuff.", "utf-8");

    const importer = new SkillImporter();
    const result = importer.import({
      skillPath,
      targetDir: join(tmpDir, "skills"),
      name: "fm-skill",
    });

    const content = readFileSync(result.skillMdPath, "utf-8");
    expect(content).toContain("---");
    expect(content).toContain("name: fm-skill");
    expect(content).toContain("version: 1");
    expect(content).toContain("## Instructions");
  });

  it("should increment version on re-import", () => {
    const skillPath = join(tmpDir, "best_skill.md");
    writeFileSync(skillPath, "Version 1 content.", "utf-8");

    const importer = new SkillImporter();
    const targetDir = join(tmpDir, "skills");

    importer.import({ skillPath, targetDir, name: "versioned" });

    writeFileSync(skillPath, "Version 2 content.", "utf-8");
    const result2 = importer.import({ skillPath, targetDir, name: "versioned" });

    expect(result2.metadata.version).toBe(2);
  });

  it("should store training metadata", () => {
    const skillPath = join(tmpDir, "best_skill.md");
    writeFileSync(skillPath, "Trained content.", "utf-8");

    const importer = new SkillImporter();
    const result = importer.import({
      skillPath,
      targetDir: join(tmpDir, "skills"),
      name: "meta-skill",
      trainingMeta: {
        runName: "run-2026-05",
        passRate: 0.85,
        accuracy: 0.92,
      },
    });

    expect(result.metadata.passRate).toBe(0.85);
    expect(result.metadata.accuracy).toBe(0.92);
    expect(result.metadata.trainedFrom).toBe("run-2026-05");
  });

  it("should throw for non-existent skill file", () => {
    const importer = new SkillImporter();
    expect(() =>
      importer.import({
        skillPath: "/nonexistent/best_skill.md",
        targetDir: join(tmpDir, "skills"),
      }),
    ).toThrow("Skill file not found");
  });

  it("should compare two skill versions", () => {
    const skillA = join(tmpDir, "skillA.md");
    const skillB = join(tmpDir, "skillB.md");
    writeFileSync(skillA, "Skill A", "utf-8");
    writeFileSync(skillB, "Skill B", "utf-8");

    const importer = new SkillImporter();
    const targetDir = join(tmpDir, "compare-skills");

    const rA = importer.import({
      skillPath: skillA,
      targetDir,
      name: "skill-a",
      trainingMeta: { runName: "run-a", passRate: 0.7 },
    });
    const rB = importer.import({
      skillPath: skillB,
      targetDir,
      name: "skill-b",
      trainingMeta: { runName: "run-b", passRate: 0.9 },
    });

    const comparison = importer.compare(rA.skillDir, rB.skillDir);
    expect(comparison).not.toBeNull();
    expect(comparison!.passRateDiff).toBeCloseTo(0.2);
  });

  it("should use custom tags", () => {
    const skillPath = join(tmpDir, "best_skill.md");
    writeFileSync(skillPath, "Tagged skill.", "utf-8");

    const importer = new SkillImporter();
    const result = importer.import({
      skillPath,
      targetDir: join(tmpDir, "skills"),
      name: "tagged",
      tags: ["production", "v2", "optimized"],
    });

    expect(result.metadata.tags).toEqual(["production", "v2", "optimized"]);
  });
});

// ── SkillOptAdapter Tests (type/config validation only, no Python) ──────────

describe("SkillOptAdapter config", () => {
  it("should reject missing skillOptPath", async () => {
    const { SkillOptAdapter } = await import("../skill-opt-adapter.js");
    expect(() => new SkillOptAdapter({ skillOptPath: "", optimizerModel: "gpt-4", targetModel: "gpt-4o-mini" })).toThrow(
      "skillOptPath is required",
    );
  });

  it("should reject non-existent path", async () => {
    const { SkillOptAdapter } = await import("../skill-opt-adapter.js");
    expect(
      () =>
        new SkillOptAdapter({
          skillOptPath: "/nonexistent/skillopt",
          optimizerModel: "gpt-4",
          targetModel: "gpt-4o-mini",
        }),
    ).toThrow("does not exist");
  });

  it("should accept valid config with defaults", async () => {
    const tmpDir = makeTmpDir("adapter-config");
    const { SkillOptAdapter } = await import("../skill-opt-adapter.js");
    const adapter = new SkillOptAdapter({
      skillOptPath: tmpDir,
      optimizerModel: "gpt-4",
      targetModel: "gpt-4o-mini",
    });

    expect(adapter.getCurrentRun()).toBeNull();
    cleanup(tmpDir);
  });
});

// ── Trainer Config Tests ────────────────────────────────────────────────────

describe("Trainer config", () => {
  it("should be importable from training index", async () => {
    const mod = await import("../index.js");
    expect(mod.Trainer).toBeDefined();
    expect(mod.DataPreparer).toBeDefined();
    expect(mod.SkillImporter).toBeDefined();
    expect(mod.TrainingEvalRunner).toBeDefined();
    expect(mod.SkillOptAdapter).toBeDefined();
  });
});
