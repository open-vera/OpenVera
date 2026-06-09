/**
 * GAIA Benchmark Runner — Run GAIA evaluation through BenchmarkHarness.
 *
 * Bridges GAIA-format cases to BenchmarkHarness, adding:
 * - GAIA raw format → EvalCase conversion
 * - Per-level timeout configuration
 * - Level filtering (L1/L2/L3)
 * - GAIA-specific metrics (per-level pass rate, avg steps)
 */

import { BenchmarkHarness } from "./harness.js";
import type { BenchmarkConfig, BenchmarkResult } from "./harness.js";
import type { EvalCase, AgentExecutor } from "@open-vera/harness-eval";

// ── GAIA Raw Case Format ─────────────────────────────────────────────────────

export interface GaiaBenchmarkRawCase {
  task_id: string;
  question: string;
  level: 1 | 2 | 3;
  final_answer: string;
  file_name?: string;
  file_path?: string;
  annotator_metadata?: Record<string, unknown>;
}

// ── GAIA Benchmark Options ───────────────────────────────────────────────────

export interface GaiaBenchmarkOptions {
  /** Benchmark name (default: "gaia-l1") */
  name?: string;
  /** Model being benchmarked */
  model?: string;
  /** Filter to specific levels (default: [1]) */
  levels?: (1 | 2 | 3)[];
  /** Max cases to load (for smoke tests) */
  maxCases?: number;
  /** Number of repeat runs for flaky detection */
  repeatRuns?: number;
  /** Flaky threshold */
  flakyThreshold?: number;
  /** Cost budget in USD */
  budgetUsd?: number;
  /** Override per-level timeouts */
  levelTimeouts?: Partial<Record<1 | 2 | 3, number>>;
}

// ── GAIA Benchmark Runner ────────────────────────────────────────────────────

export class GaiaBenchmarkRunner {
  private harness: BenchmarkHarness;
  private options: Required<
    Pick<GaiaBenchmarkOptions, "name" | "levels">
  > &
    GaiaBenchmarkOptions;

  constructor(options: GaiaBenchmarkOptions = {}) {
    this.options = {
      name: options.name ?? "gaia-l1",
      model: options.model ?? "unknown",
      levels: options.levels ?? [1],
      ...options,
    };

    const config: BenchmarkConfig = {
      name: this.options.name,
      model: this.options.model,
      repeatRuns: options.repeatRuns ?? 1,
      flakyThreshold: options.flakyThreshold ?? 0.1,
      budgetUsd: options.budgetUsd ?? 10.0,
      timeoutMs: this.defaultTimeout(),
    };

    this.harness = new BenchmarkHarness(config);
  }

  /**
   * Load GAIA cases from raw GAIA-format objects.
   */
  loadCases(rawCases: GaiaBenchmarkRawCase[]): void {
    let cases = rawCases.map((c) => this.toEvalCase(c));

    const levelSet = new Set(this.options.levels);
    cases = cases.filter((c) => levelSet.has(c.level));

    if (this.options.maxCases && cases.length > this.options.maxCases) {
      cases = cases.slice(0, this.options.maxCases);
    }

    this.harness.loadCases(cases);
  }

  /**
   * Load GAIA cases from a JSON string.
   */
  loadCasesFromJson(json: string): void {
    const rawCases = JSON.parse(json) as GaiaBenchmarkRawCase[];
    this.loadCases(rawCases);
  }

  /**
   * Run the benchmark.
   */
  async run(agent: AgentExecutor): Promise<BenchmarkResult> {
    return this.harness.run(agent);
  }

  /**
   * Get loaded case count.
   */
  getCaseCount(): number {
    return this.harness.getCaseCount();
  }

  /**
   * Check for regressions against a baseline.
   */
  checkRegression(
    current: BenchmarkResult,
    baseline: BenchmarkResult | null,
    threshold?: number,
  ) {
    return this.harness.checkRegression(current, baseline, threshold);
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  private toEvalCase(raw: GaiaBenchmarkRawCase): EvalCase {
    return {
      id: raw.task_id,
      description: raw.question.slice(0, 120),
      level: raw.level,
      prompt: this.buildPrompt(raw),
      expected: raw.final_answer,
      evalType: "contains",
      tags: this.extractTags(raw),
      timeoutMs: this.levelTimeout(raw.level),
    };
  }

  private buildPrompt(raw: GaiaBenchmarkRawCase): string {
    let prompt = raw.question;
    if (raw.file_name) {
      prompt += `\n\n[Attached file: ${raw.file_name}]`;
    }
    return prompt;
  }

  private extractTags(raw: GaiaBenchmarkRawCase): string[] {
    const tags = [`gaia-level-${raw.level}`];
    if (raw.file_name) tags.push("has-file");
    if (raw.annotator_metadata) {
      const meta = raw.annotator_metadata as Record<string, string>;
      if (meta.Category) tags.push(meta.Category);
    }
    return tags;
  }

  private levelTimeout(level: 1 | 2 | 3): number {
    const overrides = this.options.levelTimeouts;
    if (overrides?.[level] !== undefined) return overrides[level]!;
    switch (level) {
      case 1: return 60_000;
      case 2: return 120_000;
      case 3: return 300_000;
    }
  }

  private defaultTimeout(): number {
    const levels = this.options.levels;
    if (levels.length === 1) {
      return this.levelTimeout(levels[0]);
    }
    return Math.max(...levels.map((l) => this.levelTimeout(l)));
  }
}
