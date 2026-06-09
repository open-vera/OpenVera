/**
 * ToolBench Runner — Execute ToolBench benchmark through EvalHarness.
 *
 * ToolBench has 16464 tasks for evaluating tool/API usage capability.
 *
 * Evaluation dimensions:
 * - API call accuracy: correct API endpoint selected
 * - Parameter correctness: correct parameters passed to API
 * - Multi-step tool chains: ability to chain multiple API calls
 *
 * Metrics: tool accuracy, pass rate, avg API calls
 */

import { EvalHarness, type EvalCase, type EvalReport, type AgentExecutor } from "../harness.js";

// ── ToolBench Case Format ─────────────────────────────────────────────────

export interface ToolBenchRawCase {
  /** Unique task ID */
  task_id: string;
  /** The user's natural language request */
  query: string;
  /** Category: single-tool, multi-tool, multi-turn */
  category: "single-tool" | "multi-tool" | "multi-turn";
  /** Expected tool/API calls the agent should make */
  expected_tool_calls: ToolCallSpec[];
  /** Difficulty level */
  difficulty?: "easy" | "medium" | "hard";
  /** Available tools/APIs for this task */
  available_tools?: ToolSpec[];
  /** Optional context or constraints */
  context?: string;
  /** Expected final answer pattern */
  expected_answer?: string;
}

export interface ToolCallSpec {
  /** API/tool name */
  tool: string;
  /** Expected parameters (subset match — agent params must include these) */
  parameters?: Record<string, unknown>;
  /** Whether this call is optional (agent may skip) */
  optional?: boolean;
}

export interface ToolSpec {
  /** Tool name */
  name: string;
  /** Tool description */
  description: string;
  /** Parameter schema */
  parameters?: Record<string, unknown>;
}

// ── ToolBench Runner Options ──────────────────────────────────────────────

export interface ToolBenchRunnerOptions {
  /** Model/agent name for reporting */
  model?: string;
  /** Max concurrent evaluations */
  concurrency?: number;
  /** Global timeout per case in ms (default: 180_000) */
  timeoutMs?: number;
  /** Filter by category */
  categories?: ("single-tool" | "multi-tool" | "multi-turn")[];
  /** Filter by difficulty */
  difficulties?: ("easy" | "medium" | "hard")[];
  /** Max cases to run (for quick smoke tests) */
  maxCases?: number;
}

// ── ToolBench Metrics ─────────────────────────────────────────────────────

export interface ToolBenchMetrics {
  /** Cases where agent selected the correct primary API */
  toolAccuracy: number;
  /** Cases that passed overall */
  passed: number;
  /** Total cases evaluated */
  total: number;
  /** Pass rate */
  passRate: number;
  /** Average number of API calls per case */
  avgApiCalls: number;
  /** Per-category breakdown */
  byCategory: Record<string, { total: number; passed: number; passRate: number }>;
}

// ── ToolBench Runner ──────────────────────────────────────────────────────

export class ToolBenchRunner {
  private harness: EvalHarness;
  private options: ToolBenchRunnerOptions;
  private rawCases: ToolBenchRawCase[] = [];

  constructor(agent: AgentExecutor, options: ToolBenchRunnerOptions = {}) {
    this.options = options;
    this.harness = new EvalHarness(agent, {
      name: "ToolBench",
      concurrency: options.concurrency ?? 1,
      timeoutMs: options.timeoutMs ?? 180_000,
      model: options.model ?? "unknown",
    });
  }

  /**
   * Load ToolBench cases from an array of raw format objects.
   */
  loadCases(rawCases: ToolBenchRawCase[]): void {
    let cases = [...rawCases];

    if (this.options.categories && this.options.categories.length > 0) {
      const catSet = new Set(this.options.categories);
      cases = cases.filter((c) => catSet.has(c.category));
    }

    if (this.options.difficulties && this.options.difficulties.length > 0) {
      const diffSet = new Set(this.options.difficulties);
      cases = cases.filter((c) => c.difficulty && diffSet.has(c.difficulty));
    }

    if (this.options.maxCases && cases.length > this.options.maxCases) {
      cases = cases.slice(0, this.options.maxCases);
    }

    this.rawCases = cases;
    this.harness.loadCases(cases.map((c) => this.toEvalCase(c)));
  }

  /**
   * Load ToolBench cases from a JSON string.
   */
  loadCasesFromJson(json: string): void {
    const rawCases = JSON.parse(json) as ToolBenchRawCase[];
    this.loadCases(rawCases);
  }

  /**
   * Run all loaded ToolBench cases.
   */
  async runAll(): Promise<EvalReport> {
    return this.harness.runAll();
  }

  /**
   * Run all cases and compute ToolBench-specific metrics.
   */
  async runAllWithMetrics(): Promise<{ report: EvalReport; metrics: ToolBenchMetrics }> {
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
  getRawCases(): ToolBenchRawCase[] {
    return [...this.rawCases];
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  private toEvalCase(raw: ToolBenchRawCase): EvalCase {
    return {
      id: raw.task_id,
      description: raw.query.slice(0, 120).replace(/\n/g, " "),
      level: this.categoryToLevel(raw.category, raw.difficulty),
      prompt: this.buildPrompt(raw),
      expected: raw.expected_answer ?? this.buildExpectedFromTools(raw.expected_tool_calls),
      evalType: raw.expected_answer ? "contains" : "tool_match",
      expectedTools: raw.expected_tool_calls
        .filter((t) => !t.optional)
        .map((t) => t.tool),
      tags: this.extractTags(raw),
      timeoutMs: this.difficultyTimeout(raw.difficulty),
      maxCostUsd: 1.0,
    };
  }

  private buildPrompt(raw: ToolBenchRawCase): string {
    const parts: string[] = [];

    parts.push(`# Task: ${raw.task_id}`);
    parts.push("");
    parts.push(`**Category**: ${raw.category}`);
    if (raw.difficulty) {
      parts.push(`**Difficulty**: ${raw.difficulty}`);
    }
    parts.push("");

    if (raw.available_tools && raw.available_tools.length > 0) {
      parts.push("## Available Tools");
      parts.push("");
      parts.push("```json");
      parts.push(JSON.stringify(raw.available_tools, null, 2));
      parts.push("```");
      parts.push("");
    }

    parts.push("## Request");
    parts.push("");
    parts.push(raw.query);

    if (raw.context) {
      parts.push("");
      parts.push("## Context");
      parts.push("");
      parts.push(raw.context);
    }

    parts.push("");
    parts.push("## Instructions");
    parts.push("");
    parts.push("1. Analyze the request and determine which tools/APIs to call");
    parts.push("2. Make the necessary tool calls with correct parameters");
    parts.push("3. If multiple steps are needed, chain the calls appropriately");
    parts.push("4. Provide your final answer based on the tool results");

    return parts.join("\n");
  }

  private extractTags(raw: ToolBenchRawCase): string[] {
    const tags: string[] = [];

    tags.push(`category:${raw.category}`);

    if (raw.difficulty) {
      tags.push(`difficulty:${raw.difficulty}`);
    }

    // Tag by number of expected tool calls
    const callCount = raw.expected_tool_calls.length;
    if (callCount === 1) tags.push("single-call");
    else if (callCount <= 3) tags.push("few-calls");
    else tags.push("many-calls");

    // Tag by tool names
    for (const tc of raw.expected_tool_calls) {
      tags.push(`tool:${tc.tool}`);
    }

    return tags;
  }

  private categoryToLevel(
    category: "single-tool" | "multi-tool" | "multi-turn",
    difficulty?: "easy" | "medium" | "hard",
  ): 1 | 2 | 3 {
    // Combine category and difficulty for level mapping
    if (difficulty === "hard" || category === "multi-turn") return 3;
    if (difficulty === "medium" || category === "multi-tool") return 2;
    return 1;
  }

  private difficultyTimeout(difficulty?: "easy" | "medium" | "hard"): number {
    switch (difficulty) {
      case "easy": return 60_000;
      case "medium": return 120_000;
      case "hard": return 300_000;
      default: return 180_000;
    }
  }

  private buildExpectedFromTools(tools: ToolCallSpec[]): string {
    return tools
      .filter((t) => !t.optional)
      .map((t) => t.tool)
      .join(", ");
  }

  private computeMetrics(report: EvalReport): ToolBenchMetrics {
    // Tool accuracy: cases where tool_match scored >= 0.8
    const toolAccurate = report.results.filter((r) => r.score >= 0.8).length;
    const toolAccuracy = report.totalCases > 0 ? toolAccurate / report.totalCases : 0;

    // Per-category breakdown
    const byCategory: Record<string, { total: number; passed: number; passRate: number }> = {};
    for (const result of report.results) {
      const rawCase = this.rawCases.find((c) => c.task_id === result.caseId);
      const cat = rawCase?.category ?? "unknown";
      if (!byCategory[cat]) byCategory[cat] = { total: 0, passed: 0, passRate: 0 };
      byCategory[cat].total++;
      if (result.status === "pass") byCategory[cat].passed++;
    }
    for (const cat of Object.keys(byCategory)) {
      const c = byCategory[cat];
      c.passRate = c.total > 0 ? c.passed / c.total : 0;
    }

    // Avg API calls: count tool calls in responses
    const totalToolCalls = report.results.reduce((s, r) => s + r.toolCalls.length, 0);
    const avgApiCalls = report.totalCases > 0 ? totalToolCalls / report.totalCases : 0;

    return {
      toolAccuracy,
      passed: report.passed,
      total: report.totalCases,
      passRate: report.passRate,
      avgApiCalls,
      byCategory,
    };
  }
}
