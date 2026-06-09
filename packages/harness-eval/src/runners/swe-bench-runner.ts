/**
 * SWE-bench Runner — Execute SWE-bench benchmark through EvalHarness.
 *
 * SWE-bench has 2294 GitHub issues for evaluating code repair capability.
 * Each case contains a problem statement, the repo context, and a gold patch.
 *
 * Evaluation flow: read issue → locate code → generate patch → verify tests pass
 *
 * Metrics: pass rate, patch accuracy, test pass rate
 */

import { EvalHarness, type EvalCase, type EvalReport, type AgentExecutor } from "../harness.js";

// ── SWE-bench Case Format ─────────────────────────────────────────────────

export interface SweBenchRawCase {
  /** Unique instance ID (e.g., "scikit-learn__scikit-learn-13779") */
  instance_id: string;
  /** The GitHub issue description / problem statement */
  problem_statement: string;
  /** Base commit SHA to start from */
  base_commit: string;
  /** Gold patch (the expected fix) — used for evaluation */
  patch: string;
  /** Test patch — tests that should pass after applying the fix */
  test_patch: string;
  /** Repository in owner/repo format */
  repo: string;
  /** Optional hints for the agent */
  hints?: string;
  /** Python version for the environment */
  version?: string;
  /** Setup/install instructions for the environment */
  environment?: string;
  /** Difficulty: pre-seeded by SWE-bench authors */
  difficulty?: "easy" | "medium" | "hard";
}

// ── SWE-bench Runner Options ──────────────────────────────────────────────

export interface SweBenchRunnerOptions {
  /** Model/agent name for reporting */
  model?: string;
  /** Max concurrent evaluations */
  concurrency?: number;
  /** Global timeout per case in ms (default: 300_000 — code fixes can be slow) */
  timeoutMs?: number;
  /** Filter by difficulty */
  difficulties?: ("easy" | "medium" | "hard")[];
  /** Filter by repository */
  repos?: string[];
  /** Max cases to run (for quick smoke tests) */
  maxCases?: number;
  /** Whether to include the gold patch as hint (for debugging, default false) */
  includeGoldPatch?: boolean;
  /** Whether to include test patch in prompt (helps agent understand what to verify) */
  includeTestPatch?: boolean;
}

// ── SWE-bench Metrics ─────────────────────────────────────────────────────

export interface SweBenchMetrics {
  /** Cases where the agent's patch resolves the issue (all tests pass) */
  resolved: number;
  /** Cases where the agent produced a non-empty patch */
  patched: number;
  /** Cases where applied patch is semantically equivalent to gold */
  patchAccuracy: number;
  /** Total cases evaluated */
  total: number;
  /** Resolved rate */
  resolvedRate: number;
  /** Patch application rate (non-empty patches) */
  patchRate: number;
}

// ── SWE-bench Runner ──────────────────────────────────────────────────────

export class SweBenchRunner {
  private harness: EvalHarness;
  private options: SweBenchRunnerOptions;
  private rawCases: SweBenchRawCase[] = [];

  constructor(agent: AgentExecutor, options: SweBenchRunnerOptions = {}) {
    this.options = options;
    this.harness = new EvalHarness(agent, {
      name: "SWE-bench",
      concurrency: options.concurrency ?? 1,
      timeoutMs: options.timeoutMs ?? 300_000,
      model: options.model ?? "unknown",
    });
  }

  /**
   * Load SWE-bench cases from an array of raw format objects.
   */
  loadCases(rawCases: SweBenchRawCase[]): void {
    let cases = [...rawCases];

    if (this.options.difficulties && this.options.difficulties.length > 0) {
      const diffSet = new Set(this.options.difficulties);
      cases = cases.filter((c) => c.difficulty && diffSet.has(c.difficulty));
    }

    if (this.options.repos && this.options.repos.length > 0) {
      const repoSet = new Set(this.options.repos);
      cases = cases.filter((c) => repoSet.has(c.repo));
    }

    if (this.options.maxCases && cases.length > this.options.maxCases) {
      cases = cases.slice(0, this.options.maxCases);
    }

    this.rawCases = cases;
    this.harness.loadCases(cases.map((c) => this.toEvalCase(c)));
  }

  /**
   * Load SWE-bench cases from a JSON string.
   */
  loadCasesFromJson(json: string): void {
    const rawCases = JSON.parse(json) as SweBenchRawCase[];
    this.loadCases(rawCases);
  }

  /**
   * Run all loaded SWE-bench cases.
   */
  async runAll(): Promise<EvalReport> {
    return this.harness.runAll();
  }

  /**
   * Run all cases and compute SWE-bench-specific metrics.
   */
  async runAllWithMetrics(): Promise<{ report: EvalReport; metrics: SweBenchMetrics }> {
    const report = await this.harness.runAll();
    const metrics = this.computeMetrics(report);
    return { report, metrics };
  }

  /**
   * Get loaded case count.
   */
  getCaseCount(): number {
    return this.harness.getCaseCount();
  }

  /**
   * Get raw cases (for inspection/debugging).
   */
  getRawCases(): SweBenchRawCase[] {
    return [...this.rawCases];
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  private toEvalCase(raw: SweBenchRawCase): EvalCase {
    return {
      id: raw.instance_id,
      description: raw.problem_statement.slice(0, 120).replace(/\n/g, " "),
      level: this.difficultyToLevel(raw.difficulty),
      prompt: this.buildPrompt(raw),
      // SWE-bench uses patch matching for evaluation
      expected: raw.patch,
      evalType: "contains",
      tags: this.extractTags(raw),
      timeoutMs: this.difficultyTimeout(raw.difficulty),
      maxCostUsd: 2.0,
    };
  }

  private buildPrompt(raw: SweBenchRawCase): string {
    const parts: string[] = [];

    parts.push(`# Issue: ${raw.instance_id}`);
    parts.push("");
    parts.push(`**Repository**: ${raw.repo}`);
    parts.push(`**Base commit**: ${raw.base_commit}`);
    parts.push("");
    parts.push("## Problem Statement");
    parts.push("");
    parts.push(raw.problem_statement);

    if (raw.hints) {
      parts.push("");
      parts.push("## Hints");
      parts.push("");
      parts.push(raw.hints);
    }

    if (raw.version) {
      parts.push("");
      parts.push(`**Python version**: ${raw.version}`);
    }

    if (raw.environment) {
      parts.push("");
      parts.push("## Environment Setup");
      parts.push("");
      parts.push(raw.environment);
    }

    if (this.options.includeTestPatch && raw.test_patch) {
      parts.push("");
      parts.push("## Test Patch (for verification)");
      parts.push("");
      parts.push("```diff");
      parts.push(raw.test_patch);
      parts.push("```");
    }

    if (this.options.includeGoldPatch && raw.patch) {
      parts.push("");
      parts.push("## Expected Patch (for reference)");
      parts.push("");
      parts.push("```diff");
      parts.push(raw.patch);
      parts.push("```");
    }

    parts.push("");
    parts.push("## Instructions");
    parts.push("");
    parts.push("1. Analyze the problem statement and understand the issue");
    parts.push("2. Locate the relevant source files in the repository");
    parts.push("3. Generate a minimal patch that fixes the issue");
    parts.push("4. Output your patch in unified diff format (```diff ... ```)");

    return parts.join("\n");
  }

  private extractTags(raw: SweBenchRawCase): string[] {
    const tags: string[] = [];

    if (raw.repo) {
      tags.push(`repo:${raw.repo}`);
    }

    if (raw.difficulty) {
      tags.push(`difficulty:${raw.difficulty}`);
    }

    // Extract programming language hints from patches
    if (raw.patch.includes(".py")) tags.push("lang:python");
    if (raw.patch.includes(".js") || raw.patch.includes(".ts")) tags.push("lang:javascript");

    return tags;
  }

  private difficultyToLevel(difficulty?: "easy" | "medium" | "hard"): 1 | 2 | 3 {
    switch (difficulty) {
      case "easy": return 1;
      case "medium": return 2;
      case "hard": return 3;
      default: return 2;
    }
  }

  private difficultyTimeout(difficulty?: "easy" | "medium" | "hard"): number {
    switch (difficulty) {
      case "easy": return 120_000;
      case "medium": return 300_000;
      case "hard": return 600_000;
      default: return 300_000;
    }
  }

  private computeMetrics(report: EvalReport): SweBenchMetrics {
    // A case is "resolved" if score >= 0.8 (pass threshold)
    const resolved = report.results.filter((r) => r.status === "pass").length;

    // A case is "patched" if the agent produced a non-empty response with diff markers
    const patched = report.results.filter(
      (r) => r.response.length > 0 && (r.response.includes("---") || r.response.includes("+++")),
    ).length;

    // Patch accuracy: average score across all cases
    const patchAccuracy = report.avgScore;

    return {
      resolved,
      patched,
      patchAccuracy,
      total: report.totalCases,
      resolvedRate: report.totalCases > 0 ? resolved / report.totalCases : 0,
      patchRate: report.totalCases > 0 ? patched / report.totalCases : 0,
    };
  }
}
