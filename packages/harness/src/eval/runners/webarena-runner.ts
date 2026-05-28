/**
 * WebArena Runner — Execute WebArena benchmark through EvalHarness.
 *
 * WebArena is a web agent benchmark with 812 tasks across 5 website types:
 * - Shopping (OneStopShop)
 * - Reddit-like forum (Postmill)
 * - GitLab-like code hosting (GitLab)
 * - CMS (WordPress/Django)
 * - Map/navigation (OpenStreetMap)
 *
 * Each task requires the agent to navigate websites and perform actions.
 * Evaluation is done via URL matching, content checks, or programmatic JS evaluation.
 *
 * Metrics: pass rate, avg steps, avg duration, per-site breakdown
 */

import {
  EvalHarness,
  type EvalCase,
  type EvalReport,
  type AgentExecutor,
} from "../harness.js";

// ── WebArena Case Format ────────────────────────────────────────────────────

export type WebArenaSite =
  | "shopping"
  | "forum"
  | "gitlab"
  | "cms"
  | "map"
  | "reddit"
  | "wikipedia";

export type WebArenaEvalType =
  | "url_match"
  | "content_match"
  | "programmatic"
  | "llm_judge";

export interface WebArenaEvalConfig {
  /** Evaluation method for this case */
  type: WebArenaEvalType;
  /** For url_match: expected URL pattern (regex or exact) */
  urlPattern?: string;
  /** For content_match: text that must appear on the final page */
  contentContains?: string[];
  /** For programmatic: JavaScript to evaluate, should return boolean */
  evalScript?: string;
  /** For llm_judge: reference answer for comparison */
  referenceAnswer?: string;
}

export interface WebArenaRawCase {
  /** Unique task ID */
  task_id: string;
  /** Website/site type */
  site: WebArenaSite;
  /** Starting URL */
  startUrl: string;
  /** Task intent / instruction for the agent */
  intent: string;
  /** Evaluation configuration */
  eval: WebArenaEvalConfig;
  /** Difficulty: 1=simple navigation, 2=multi-step, 3=complex workflow */
  level?: 1 | 2 | 3;
  /** Maximum steps allowed */
  maxSteps?: number;
  /** Timeout override in ms */
  timeoutMs?: number;
  /** Category tags for filtering */
  tags?: string[];
}

// ── WebArena Runner Options ─────────────────────────────────────────────────

export interface WebArenaRunnerOptions {
  /** Model/agent name for reporting */
  model?: string;
  /** Max concurrent evaluations */
  concurrency?: number;
  /** Global timeout per case in ms (default: 180_000 — web tasks are slow) */
  timeoutMs?: number;
  /** Filter by site type */
  sites?: WebArenaSite[];
  /** Filter by level */
  levels?: (1 | 2 | 3)[];
  /** Max cases to run (for quick smoke tests) */
  maxCases?: number;
}

// ── WebArena Runner ─────────────────────────────────────────────────────────

export class WebArenaRunner {
  private harness: EvalHarness;
  private options: WebArenaRunnerOptions;

  constructor(agent: AgentExecutor, options: WebArenaRunnerOptions = {}) {
    this.options = options;
    this.harness = new EvalHarness(agent, {
      name: "WebArena",
      concurrency: options.concurrency ?? 1,
      timeoutMs: options.timeoutMs ?? 180_000,
      model: options.model ?? "unknown",
    });
  }

  /**
   * Load WebArena cases from an array of raw WebArena-format objects.
   */
  loadCases(rawCases: WebArenaRawCase[]): void {
    let cases = rawCases.map((c) => this.toEvalCase(c));

    if (this.options.sites && this.options.sites.length > 0) {
      const siteSet = new Set(this.options.sites);
      cases = cases.filter((c) => {
        const site = c.tags?.find((t) => t.startsWith("site:"))?.slice(5);
        return site && siteSet.has(site as WebArenaSite);
      });
    }

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
   * Load WebArena cases from a JSON string.
   */
  loadCasesFromJson(json: string): void {
    const rawCases = JSON.parse(json) as WebArenaRawCase[];
    this.loadCases(rawCases);
  }

  /**
   * Run all loaded WebArena cases.
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

  private toEvalCase(raw: WebArenaRawCase): EvalCase {
    const level = raw.level ?? this.inferLevel(raw);
    return {
      id: raw.task_id,
      description: raw.intent.slice(0, 120),
      level,
      prompt: this.buildPrompt(raw),
      expected: this.buildExpected(raw),
      evalType: this.mapEvalType(raw.eval.type),
      tags: this.buildTags(raw),
      timeoutMs: raw.timeoutMs ?? this.levelTimeout(level),
    };
  }

  private buildPrompt(raw: WebArenaRawCase): string {
    const parts: string[] = [];
    parts.push(`[WebArena Task] ${raw.intent}`);
    parts.push(`\nStarting URL: ${raw.startUrl}`);
    parts.push(`Website: ${raw.site}`);
    if (raw.maxSteps) {
      parts.push(`Max steps: ${raw.maxSteps}`);
    }
    return parts.join("\n");
  }

  private buildExpected(raw: WebArenaRawCase): string {
    const { eval: evalConfig } = raw;
    switch (evalConfig.type) {
      case "url_match":
        return evalConfig.urlPattern ?? "";
      case "content_match":
        return (evalConfig.contentContains ?? []).join("|");
      case "programmatic":
        return evalConfig.evalScript ?? "";
      case "llm_judge":
        return evalConfig.referenceAnswer ?? "";
      default:
        return "";
    }
  }

  private mapEvalType(
    waType: WebArenaEvalType,
  ): "exact" | "contains" | "regex" | "llm_judge" | "tool_match" {
    switch (waType) {
      case "url_match":
        return "regex";
      case "content_match":
        return "contains";
      case "programmatic":
        return "exact";
      case "llm_judge":
        return "llm_judge";
      default:
        return "contains";
    }
  }

  private buildTags(raw: WebArenaRawCase): string[] {
    const tags = [`site:${raw.site}`, `level-${raw.level ?? this.inferLevel(raw)}`];
    if (raw.tags) tags.push(...raw.tags);
    return tags;
  }

  private inferLevel(raw: WebArenaRawCase): 1 | 2 | 3 {
    // Infer difficulty from max steps and eval type
    if (raw.maxSteps && raw.maxSteps > 10) return 3;
    if (raw.eval.type === "programmatic" || raw.eval.type === "llm_judge") return 3;
    if (raw.eval.contentContains && raw.eval.contentContains.length > 2) return 2;
    return 1;
  }

  private levelTimeout(level: 1 | 2 | 3): number {
    switch (level) {
      case 1:
        return 90_000;
      case 2:
        return 180_000;
      case 3:
        return 300_000;
    }
  }
}
