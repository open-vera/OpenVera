/**
 * Eval Harness — Framework for running agent evaluation benchmarks.
 *
 * Loads test cases, executes them against an agent, collects results,
 * and generates reports. Supports multiple benchmark formats.
 */

// ── Types ────────────────────────────────────────────────────────────────────

export type EvalStatus = "pass" | "fail" | "error" | "skip" | "timeout";

export interface EvalCase {
  /** Unique case ID */
  id: string;
  /** Human-readable description */
  description: string;
  /** Difficulty level */
  level: 1 | 2 | 3;
  /** The prompt/question to send to the agent */
  prompt: string;
  /** Expected answer or pattern (for automated grading) */
  expected?: string;
  /** Evaluation type */
  evalType: "exact" | "contains" | "regex" | "llm_judge" | "tool_match";
  /** Expected tool calls (for tool_match eval type) */
  expectedTools?: string[];
  /** Category/tags for filtering */
  tags?: string[];
  /** Timeout in ms (default: 60000) */
  timeoutMs?: number;
  /** Maximum cost in USD (default: 1.0) */
  maxCostUsd?: number;
}

export interface EvalResult {
  /** Case ID */
  caseId: string;
  /** Pass/fail/error status */
  status: EvalStatus;
  /** Score 0-1 */
  score: number;
  /** Duration in ms */
  durationMs: number;
  /** Agent's response */
  response: string;
  /** Tool calls made during execution */
  toolCalls: string[];
  /** Error message if status is error */
  error?: string;
  /** Cost in USD */
  costUsd?: number;
}

export interface EvalReport {
  /** Benchmark name */
  benchmark: string;
  /** Model/agent name */
  model: string;
  /** Timestamp */
  timestamp: string;
  /** Total cases */
  totalCases: number;
  /** Passed cases */
  passed: number;
  /** Failed cases */
  failed: number;
  /** Errored cases */
  errors: number;
  /** Skipped cases */
  skipped: number;
  /** Pass rate */
  passRate: number;
  /** Average score */
  avgScore: number;
  /** Average duration in ms */
  avgDurationMs: number;
  /** Total cost in USD */
  totalCostUsd: number;
  /** Results per level */
  byLevel: Record<number, { total: number; passed: number; passRate: number }>;
  /** Individual results */
  results: EvalResult[];
}

export interface EvalRunnerOptions {
  /** Benchmark name */
  name: string;
  /** Path to test cases JSON file */
  casesPath?: string;
  /** Max concurrent evaluations */
  concurrency?: number;
  /** Global timeout per case in ms */
  timeoutMs?: number;
  /** Model/agent name for reporting */
  model?: string;
}

// ── Agent Executor Interface ─────────────────────────────────────────────────

/**
 * Interface for executing agent calls during evaluation.
 * Implement this to connect to your specific agent runtime.
 */
export interface AgentExecutor {
  /** Execute a prompt and return the response */
  execute(prompt: string, options?: { timeoutMs?: number }): Promise<AgentResponse>;
}

export interface AgentResponse {
  /** The agent's text response */
  content: string;
  /** Tool calls made during execution */
  toolCalls: string[];
  /** Duration in ms */
  durationMs: number;
  /** Cost in USD (if available) */
  costUsd?: number;
  /** Error if execution failed */
  error?: string;
}

// ── Eval Harness ─────────────────────────────────────────────────────────────

export class EvalHarness {
  private options: Required<EvalRunnerOptions>;
  private cases: EvalCase[] = [];
  private agent: AgentExecutor;

  constructor(agent: AgentExecutor, options: EvalRunnerOptions) {
    this.agent = agent;
    this.options = {
      name: options.name,
      casesPath: options.casesPath ?? "",
      concurrency: options.concurrency ?? 1,
      timeoutMs: options.timeoutMs ?? 60_000,
      model: options.model ?? "unknown",
    };
  }

  /**
   * Load test cases from a JSON file.
   */
  loadCases(cases: EvalCase[]): void {
    this.cases = cases;
  }

  /**
   * Load test cases from a JSON string.
   */
  loadCasesFromJson(json: string): void {
    this.cases = JSON.parse(json) as EvalCase[];
  }

  /**
   * Run all loaded test cases.
   */
  async runAll(): Promise<EvalReport> {
    const results: EvalResult[] = [];

    for (const evalCase of this.cases) {
      const result = await this.runCase(evalCase);
      results.push(result);
    }

    return this.generateReport(results);
  }

  /**
   * Run a single test case.
   */
  async runCase(evalCase: EvalCase): Promise<EvalResult> {
    const start = performance.now();
    const timeoutMs = evalCase.timeoutMs ?? this.options.timeoutMs;

    try {
      const response = await this.agent.execute(evalCase.prompt, { timeoutMs });
      const durationMs = performance.now() - start;

      const score = this.evaluate(evalCase, response);
      const status: EvalStatus = score >= 0.8 ? "pass" : "fail";

      return {
        caseId: evalCase.id,
        status,
        score,
        durationMs,
        response: response.content,
        toolCalls: response.toolCalls,
        costUsd: response.costUsd,
      };
    } catch (err) {
      const durationMs = performance.now() - start;
      const isTimeout = err instanceof Error && err.message.includes("timeout");

      return {
        caseId: evalCase.id,
        status: isTimeout ? "timeout" : "error",
        score: 0,
        durationMs,
        response: "",
        toolCalls: [],
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Get loaded cases count.
   */
  getCaseCount(): number {
    return this.cases.length;
  }

  // ── Evaluation ────────────────────────────────────────────────────────────

  private evaluate(evalCase: EvalCase, response: AgentResponse): number {
    switch (evalCase.evalType) {
      case "exact":
        return this.evalExact(evalCase.expected ?? "", response.content);
      case "contains":
        return this.evalContains(evalCase.expected ?? "", response.content);
      case "regex":
        return this.evalRegex(evalCase.expected ?? "", response.content);
      case "tool_match":
        return this.evalToolMatch(evalCase.expectedTools ?? [], response.toolCalls);
      case "llm_judge":
        // LLM judge would need external API — return 0.5 as placeholder
        return 0.5;
      default:
        return 0;
    }
  }

  private evalExact(expected: string, actual: string): number {
    return expected.trim().toLowerCase() === actual.trim().toLowerCase() ? 1 : 0;
  }

  private evalContains(expected: string, actual: string): number {
    return actual.toLowerCase().includes(expected.toLowerCase()) ? 1 : 0;
  }

  private evalRegex(pattern: string, actual: string): number {
    try {
      const regex = new RegExp(pattern, "i");
      return regex.test(actual) ? 1 : 0;
    } catch {
      return 0;
    }
  }

  private evalToolMatch(expectedTools: string[], actualTools: string[]): number {
    if (expectedTools.length === 0) return 1;

    const actualSet = new Set(actualTools);
    let matched = 0;
    for (const tool of expectedTools) {
      if (actualSet.has(tool)) matched++;
    }
    return matched / expectedTools.length;
  }

  // ── Report Generation ─────────────────────────────────────────────────────

  private generateReport(results: EvalResult[]): EvalReport {
    const passed = results.filter((r) => r.status === "pass").length;
    const failed = results.filter((r) => r.status === "fail").length;
    const errors = results.filter((r) => r.status === "error").length;
    const skipped = results.filter((r) => r.status === "skip").length;

    const byLevel: Record<number, { total: number; passed: number; passRate: number }> = {};
    for (const evalCase of this.cases) {
      const level = evalCase.level;
      if (!byLevel[level]) byLevel[level] = { total: 0, passed: 0, passRate: 0 };
      byLevel[level].total++;
    }
    for (const result of results) {
      const evalCase = this.cases.find((c) => c.id === result.caseId);
      if (evalCase && result.status === "pass") {
        byLevel[evalCase.level].passed++;
      }
    }
    for (const level of Object.keys(byLevel)) {
      const l = byLevel[Number(level)];
      l.passRate = l.total > 0 ? l.passed / l.total : 0;
    }

    return {
      benchmark: this.options.name,
      model: this.options.model,
      timestamp: new Date().toISOString(),
      totalCases: results.length,
      passed,
      failed,
      errors,
      skipped,
      passRate: results.length > 0 ? passed / results.length : 0,
      avgScore: results.length > 0 ? results.reduce((s, r) => s + r.score, 0) / results.length : 0,
      avgDurationMs: results.length > 0 ? results.reduce((s, r) => s + r.durationMs, 0) / results.length : 0,
      totalCostUsd: results.reduce((s, r) => s + (r.costUsd ?? 0), 0),
      byLevel,
      results,
    };
  }
}
