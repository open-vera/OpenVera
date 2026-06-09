/**
 * GAIA Runner — Execute GAIA (General AI Assistants) benchmark through EvalHarness.
 *
 * GAIA has 466 questions across 3 difficulty levels:
 * - L1: single-step tasks (simple tool calls)
 * - L2: multi-step tasks (combine multiple tools)
 * - L3: complex tasks (multi-round reasoning + tool use)
 *
 * Metrics: pass rate, avg steps, avg cost
 */

import { EvalHarness, type EvalCase, type EvalReport, type AgentExecutor } from "../harness.js";

// ── GAIA Case Format ────────────────────────────────────────────────────────

export interface GaiaRawCase {
  task_id: string;
  question: string;
  level: 1 | 2 | 3;
  final_answer: string;
  file_name?: string;
  file_path?: string;
  annotator_metadata?: Record<string, unknown>;
}

// ── GAIA Runner Options ─────────────────────────────────────────────────────

export interface GaiaRunnerOptions {
  /** Model/agent name for reporting */
  model?: string;
  /** Max concurrent evaluations */
  concurrency?: number;
  /** Global timeout per case in ms (default: 120_000 — GAIA L3 can be slow) */
  timeoutMs?: number;
  /** Filter cases by level */
  levels?: (1 | 2 | 3)[];
  /** Filter cases by tags */
  tags?: string[];
  /** Max cases to run (for quick smoke tests) */
  maxCases?: number;
}

// ── GAIA Runner ─────────────────────────────────────────────────────────────

export class GaiaRunner {
  private harness: EvalHarness;
  private options: GaiaRunnerOptions;

  constructor(agent: AgentExecutor, options: GaiaRunnerOptions = {}) {
    this.options = options;
    this.harness = new EvalHarness(agent, {
      name: "GAIA",
      concurrency: options.concurrency ?? 1,
      timeoutMs: options.timeoutMs ?? 120_000,
      model: options.model ?? "unknown",
    });
  }

  /**
   * Load GAIA cases from an array of raw GAIA-format objects.
   */
  loadCases(rawCases: GaiaRawCase[]): void {
    let cases = rawCases.map((c) => this.toEvalCase(c));

    if (this.options.levels && this.options.levels.length > 0) {
      const levelSet = new Set(this.options.levels);
      cases = cases.filter((c) => levelSet.has(c.level));
    }

    if (this.options.maxCases && cases.length > this.options.maxCases) {
      cases = cases.slice(0, this.options.maxCases);
    }

    this.harness.loadCases(cases);
  }

  /**
   * Load GAIA cases from a JSON string.
   */
  loadCasesFromJson(json: string): void {
    const rawCases = JSON.parse(json) as GaiaRawCase[];
    this.loadCases(rawCases);
  }

  /**
   * Run all loaded GAIA cases.
   */
  async runAll(): Promise<EvalReport> {
    return this.harness.runAll();
  }

  /**
   * Get loaded case count.
   */
  getCaseCount(): number {
    return this.harness.getCaseCount();
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  private toEvalCase(raw: GaiaRawCase): EvalCase {
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

  private buildPrompt(raw: GaiaRawCase): string {
    let prompt = raw.question;
    if (raw.file_name) {
      prompt += `\n\n[Attached file: ${raw.file_name}]`;
    }
    return prompt;
  }

  private extractTags(raw: GaiaRawCase): string[] {
    const tags = [`level-${raw.level}`];
    if (raw.file_name) tags.push("has-file");
    if (raw.annotator_metadata) {
      const meta = raw.annotator_metadata as Record<string, string>;
      if (meta.Category) tags.push(meta.Category);
    }
    return tags;
  }

  private levelTimeout(level: 1 | 2 | 3): number {
    switch (level) {
      case 1: return 60_000;
      case 2: return 120_000;
      case 3: return 300_000;
    }
  }
}
