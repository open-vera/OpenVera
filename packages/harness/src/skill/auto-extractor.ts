/**
 * Skill Auto-Extractor (SK1) + Auto-Scorer (SK2)
 *
 * SK1: Extracts reusable skill templates from successful execution traces.
 *      Analyzes tool call patterns, system prompt fragments, and task context
 *      to generate Skill definitions that can be reused in future tasks.
 *
 * SK2: Scores skill effectiveness after execution based on completion rate,
 *      error rate, cost, and duration. Tracks scores over time.
 */

import type { Skill, SkillTrigger, IntentDomain } from "./types.js";

// ── Extraction Types ──────────────────────────────────────────────────────────

/** A single tool call captured during execution. */
export interface ToolCallRecord {
  toolName: string;
  args: Record<string, unknown>;
  success: boolean;
  durationMs: number;
}

/** Execution trace from a completed task. */
export interface ExecutionTrace {
  /** What the task was trying to accomplish. */
  taskDescription: string;
  /** Intent domain of the task. */
  domain: IntentDomain;
  /** Complexity level. */
  level: 0 | 1 | 2 | 3;
  /** All tool calls made during execution. */
  toolCalls: ToolCallRecord[];
  /** System prompt fragments that were active. */
  systemFragments?: string[];
  /** Whether the task completed successfully. */
  success: boolean;
  /** Total cost in USD. */
  costUsd?: number;
  /** Total duration in ms. */
  durationMs?: number;
  /** Any error messages encountered. */
  errors?: string[];
}

/** Configuration for the extraction process. */
export interface ExtractorConfig {
  /** Minimum tool calls required to consider extraction. Default: 2 */
  minToolCalls: number;
  /** Minimum success rate for included tools. Default: 0.5 */
  minToolSuccessRate: number;
  /** Minimum unique tools to form a skill. Default: 1 */
  minUniqueTools: number;
  /** Max skills to keep in the store. Default: 100 */
  maxSkills: number;
}

const DEFAULT_EXTRACTOR_CONFIG: ExtractorConfig = {
  minToolCalls: 2,
  minToolSuccessRate: 0.5,
  minUniqueTools: 1,
  maxSkills: 100,
};

// ── Scoring Types ─────────────────────────────────────────────────────────────

/** Execution record for a single skill use. */
export interface SkillExecutionRecord {
  skillId: string;
  timestamp: string;
  success: boolean;
  durationMs: number;
  toolCallCount: number;
  errorCount: number;
  costUsd?: number;
}

/** Aggregated effectiveness score for a skill. */
export interface SkillScore {
  skillId: string;
  /** Overall effectiveness 0-1. */
  score: number;
  /** How many times this skill was used. */
  usageCount: number;
  /** Success rate (0-1). */
  successRate: number;
  /** Average duration in ms. */
  avgDurationMs: number;
  /** Average cost in USD. */
  avgCostUsd: number;
  /** ISO timestamp of last use. */
  lastUsedAt: string;
}

/** Configuration for the auto-scorer. */
export interface ScorerConfig {
  /** Weight for success rate in final score. Default: 0.4 */
  successWeight: number;
  /** Weight for speed (inverse duration) in final score. Default: 0.3 */
  speedWeight: number;
  /** Weight for cost efficiency in final score. Default: 0.3 */
  costWeight: number;
  /** Reference duration for normalization (ms). Default: 10000 */
  referenceDurationMs: number;
  /** Reference cost for normalization (USD). Default: 0.05 */
  referenceCostUsd: number;
}

const DEFAULT_SCORER_CONFIG: ScorerConfig = {
  successWeight: 0.4,
  speedWeight: 0.3,
  costWeight: 0.3,
  referenceDurationMs: 10_000,
  referenceCostUsd: 0.05,
};

// ── Skill Auto-Extractor ──────────────────────────────────────────────────────

export class SkillAutoExtractor {
  private config: ExtractorConfig;

  constructor(config?: Partial<ExtractorConfig>) {
    this.config = { ...DEFAULT_EXTRACTOR_CONFIG, ...config };
  }

  /**
   * Extract a skill template from a successful execution trace.
   * Returns null if the trace doesn't meet extraction criteria.
   */
  extract(trace: ExecutionTrace): ExtractedSkill | null {
    if (!trace.success) return null;
    if (trace.toolCalls.length < this.config.minToolCalls) return null;

    // Analyze tool usage patterns
    const toolStats = this.analyzeToolCalls(trace.toolCalls);
    const successfulTools = [...toolStats.entries()]
      .filter(([, stats]) => stats.total > 0 && stats.success / stats.total >= this.config.minToolSuccessRate)
      .map(([name]) => name);

    if (successfulTools.length < this.config.minUniqueTools) return null;

    // Build skill from trace
    const skillId = this.generateSkillId(trace);
    const triggers = this.inferTriggers(trace);
    const systemFragment = this.buildSystemFragment(trace, successfulTools);

    return {
      skill: {
        id: skillId,
        name: `auto:${this.slugify(trace.taskDescription)}`,
        description: `Auto-extracted from: ${trace.taskDescription}`,
        triggers,
        systemFragment,
      },
      toolNames: successfulTools,
      sourceTrace: trace,
    };
  }

  /**
   * Extract skills from a batch of traces, grouping similar ones.
   */
  extractBatch(traces: ExecutionTrace[]): ExtractedSkill[] {
    const successful = traces.filter((t) => t.success);
    const extracted: ExtractedSkill[] = [];

    for (const trace of successful) {
      const skill = this.extract(trace);
      if (skill) extracted.push(skill);
    }

    return this.deduplicateSkills(extracted);
  }

  /** Analyze tool call frequency and success rate. */
  private analyzeToolCalls(
    calls: ToolCallRecord[]
  ): Map<string, { total: number; success: number }> {
    const stats = new Map<string, { total: number; success: number }>();
    for (const call of calls) {
      const entry = stats.get(call.toolName) ?? { total: 0, success: 0 };
      entry.total++;
      if (call.success) entry.success++;
      stats.set(call.toolName, entry);
    }
    return stats;
  }

  /** Infer skill triggers from execution trace. */
  private inferTriggers(trace: ExecutionTrace): SkillTrigger[] {
    const triggers: SkillTrigger[] = [];

    // Domain-based trigger
    triggers.push({ type: "domain", domains: [trace.domain] });

    // Level trigger if complex
    if (trace.level >= 2) {
      triggers.push({ type: "level", minLevel: trace.level });
    }

    return triggers;
  }

  /** Build system fragment from trace context. */
  private buildSystemFragment(trace: ExecutionTrace, tools: string[]): string {
    const parts: string[] = [];

    parts.push(`## Auto-learned skill: ${trace.taskDescription}`);
    parts.push(`Tools involved: ${tools.join(", ")}`);

    if (trace.systemFragments && trace.systemFragments.length > 0) {
      parts.push("\n### Relevant context");
      for (const fragment of trace.systemFragments) {
        // Take only the most relevant lines (first 5)
        const lines = fragment.split("\n").slice(0, 5).join("\n");
        parts.push(lines);
      }
    }

    return parts.join("\n");
  }

  /** Generate a deterministic skill ID from trace. */
  private generateSkillId(trace: ExecutionTrace): string {
    const tools = trace.toolCalls
      .map((c) => c.toolName)
      .filter((v, i, a) => a.indexOf(v) === i)
      .sort()
      .join("-");
    return `auto-${trace.domain}-${this.slugify(tools)}-${Date.now()}`;
  }

  /** Create a URL-safe slug from text. */
  private slugify(text: string): string {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40);
  }

  /** Remove duplicate/similar extracted skills. */
  private deduplicateSkills(skills: ExtractedSkill[]): ExtractedSkill[] {
    const seen = new Map<string, ExtractedSkill>();

    for (const skill of skills) {
      const key = skill.toolNames.sort().join(",");
      const existing = seen.get(key);
      if (!existing || skill.sourceTrace.toolCalls.length > existing.sourceTrace.toolCalls.length) {
        seen.set(key, skill);
      }
    }

    return [...seen.values()];
  }
}

/** Result of skill extraction. */
export interface ExtractedSkill {
  skill: Omit<Skill, "tools">;
  toolNames: string[];
  sourceTrace: ExecutionTrace;
}

// ── Skill Auto-Scorer ─────────────────────────────────────────────────────────

export class SkillAutoScorer {
  private config: ScorerConfig;
  /** skillId → execution records */
  private records: Map<string, SkillExecutionRecord[]> = new Map();

  constructor(config?: Partial<ScorerConfig>) {
    this.config = { ...DEFAULT_SCORER_CONFIG, ...config };
  }

  /** Record a skill execution. */
  recordExecution(record: SkillExecutionRecord): void {
    const existing = this.records.get(record.skillId) ?? [];
    existing.push(record);
    this.records.set(record.skillId, existing);
  }

  /** Get the effectiveness score for a skill. */
  getScore(skillId: string): SkillScore | null {
    const records = this.records.get(skillId);
    if (!records || records.length === 0) return null;

    const usageCount = records.length;
    const successCount = records.filter((r) => r.success).length;
    const successRate = successCount / usageCount;

    const totalDuration = records.reduce((sum, r) => sum + r.durationMs, 0);
    const avgDurationMs = totalDuration / usageCount;

    const costRecords = records.filter((r) => r.costUsd !== undefined);
    const avgCostUsd =
      costRecords.length > 0
        ? costRecords.reduce((sum, r) => sum + (r.costUsd ?? 0), 0) / costRecords.length
        : 0;

    const lastUsedAt = records
      .map((r) => r.timestamp)
      .sort()
      .pop()!;

    // Composite score
    const speedScore = Math.min(1, this.config.referenceDurationMs / Math.max(1, avgDurationMs));
    const costScore =
      avgCostUsd > 0
        ? Math.min(1, this.config.referenceCostUsd / Math.max(0.001, avgCostUsd))
        : 1;

    const score =
      successRate * this.config.successWeight +
      speedScore * this.config.speedWeight +
      costScore * this.config.costWeight;

    return {
      skillId,
      score: Math.round(score * 100) / 100,
      usageCount,
      successRate: Math.round(successRate * 100) / 100,
      avgDurationMs: Math.round(avgDurationMs),
      avgCostUsd: Math.round(avgCostUsd * 1000) / 1000,
      lastUsedAt,
    };
  }

  /** Get scores for all tracked skills, sorted by score descending. */
  getAllScores(): SkillScore[] {
    const scores: SkillScore[] = [];
    for (const [skillId] of this.records) {
      const score = this.getScore(skillId);
      if (score) scores.push(score);
    }
    return scores.sort((a, b) => b.score - a.score);
  }

  /** Get execution records for a skill. */
  getRecords(skillId: string): SkillExecutionRecord[] {
    return this.records.get(skillId) ?? [];
  }

  /** Clear all records. */
  clear(): void {
    this.records.clear();
  }
}
