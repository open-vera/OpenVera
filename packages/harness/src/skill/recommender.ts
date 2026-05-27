/**
 * Skill Recommender (SK3)
 *
 * Recommends skills for a given task based on:
 * - Domain matching (task domain vs skill triggers)
 * - Keyword overlap (task description vs skill name/description/systemFragment)
 * - Historical effectiveness (SkillAutoScorer scores)
 * - Explicit user preferences
 */

import type { Skill, IntentDomain } from "./types.js";
import type { SkillScore } from "./auto-extractor.js";

// ── Types ─────────────────────────────────────────────────────────────────────

/** A task context for skill recommendation. */
export interface TaskContext {
  /** What the task is about. */
  description: string;
  /** Intent domain. */
  domain: IntentDomain;
  /** Complexity level. */
  level: 0 | 1 | 2 | 3;
  /** Keywords extracted from the task. */
  keywords?: string[];
  /** Explicitly requested skill IDs (always included). */
  explicitSkillIds?: string[];
}

/** A skill recommendation with relevance score. */
export interface SkillRecommendation {
  skill: Skill;
  /** Relevance score 0-1. */
  relevance: number;
  /** Why this skill was recommended. */
  reasons: string[];
}

/** Configuration for the recommender. */
export interface RecommenderConfig {
  /** Weight for domain match. Default: 0.4 */
  domainWeight: number;
  /** Weight for keyword overlap. Default: 0.35 */
  keywordWeight: number;
  /** Weight for historical effectiveness. Default: 0.25 */
  effectivenessWeight: number;
  /** Minimum relevance to include in results. Default: 0.2 */
  minRelevance: number;
  /** Maximum recommendations to return. Default: 10 */
  maxRecommendations: number;
}

const DEFAULT_RECOMMENDER_CONFIG: RecommenderConfig = {
  domainWeight: 0.4,
  keywordWeight: 0.35,
  effectivenessWeight: 0.25,
  minRelevance: 0.2,
  maxRecommendations: 10,
};

// ── SkillRecommender ──────────────────────────────────────────────────────────

export class SkillRecommender {
  private skills: Map<string, Skill> = new Map();
  private config: RecommenderConfig;
  private scorer?: { getScore(skillId: string): SkillScore | null };

  constructor(
    config?: Partial<RecommenderConfig>,
    scorer?: { getScore(skillId: string): SkillScore | null }
  ) {
    this.config = { ...DEFAULT_RECOMMENDER_CONFIG, ...config };
    this.scorer = scorer;
  }

  /** Register a skill for recommendation. */
  register(skill: Skill): void {
    this.skills.set(skill.id, skill);
  }

  /** Register multiple skills. */
  registerAll(skills: Skill[]): void {
    for (const skill of skills) this.register(skill);
  }

  /** Remove a skill from the recommendation pool. */
  unregister(skillId: string): boolean {
    return this.skills.delete(skillId);
  }

  /** Get all registered skills. */
  list(): Skill[] {
    return [...this.skills.values()];
  }

  /**
   * Recommend skills for a given task context.
   * Returns skills sorted by relevance descending.
   */
  recommend(task: TaskContext): SkillRecommendation[] {
    const results: SkillRecommendation[] = [];

    for (const skill of this.skills.values()) {
      const { score, reasons } = this.scoreSkill(skill, task);

      // Explicit skills always included regardless of score
      const isExplicit = task.explicitSkillIds?.includes(skill.id) ?? false;
      if (isExplicit || score >= this.config.minRelevance) {
        results.push({
          skill,
          relevance: isExplicit ? 1.0 : score,
          reasons: isExplicit ? ["explicitly requested", ...reasons] : reasons,
        });
      }
    }

    return results
      .sort((a, b) => b.relevance - a.relevance)
      .slice(0, this.config.maxRecommendations);
  }

  /** Score a single skill against a task context. */
  private scoreSkill(
    skill: Skill,
    task: TaskContext
  ): { score: number; reasons: string[] } {
    const reasons: string[] = [];
    let weightedScore = 0;

    // 1. Domain match
    const domainScore = this.computeDomainScore(skill, task);
    weightedScore += domainScore * this.config.domainWeight;
    if (domainScore > 0) reasons.push(`domain match (${Math.round(domainScore * 100)}%)`);

    // 2. Keyword overlap
    const keywordScore = this.computeKeywordScore(skill, task);
    weightedScore += keywordScore * this.config.keywordWeight;
    if (keywordScore > 0) reasons.push(`keyword overlap (${Math.round(keywordScore * 100)}%)`);

    // 3. Historical effectiveness
    const effectivenessScore = this.computeEffectivenessScore(skill.id);
    weightedScore += effectivenessScore * this.config.effectivenessWeight;
    if (effectivenessScore > 0)
      reasons.push(`effectiveness (${Math.round(effectivenessScore * 100)}%)`);

    return { score: Math.round(weightedScore * 100) / 100, reasons };
  }

  /** Compute domain match score (0-1). */
  private computeDomainScore(skill: Skill, task: TaskContext): number {
    for (const trigger of skill.triggers) {
      switch (trigger.type) {
        case "always":
          return 0.5; // Always-active skills get partial match
        case "domain":
          if (trigger.domains.includes(task.domain)) return 1.0;
          break;
        case "level":
          if (task.level >= trigger.minLevel) return 0.7;
          break;
        case "needs_tools":
          return 0.3; // Generic match
      }
    }
    return 0;
  }

  /** Compute keyword overlap score (0-1). */
  private computeKeywordScore(skill: Skill, task: TaskContext): number {
    const taskKeywords = new Set([
      ...this.tokenize(task.description),
      ...(task.keywords ?? []),
    ]);

    if (taskKeywords.size === 0) return 0;

    const skillText = [skill.name, skill.description, skill.systemFragment ?? ""].join(" ");
    const skillKeywords = this.tokenize(skillText);

    let overlap = 0;
    for (const kw of skillKeywords) {
      if (taskKeywords.has(kw)) overlap++;
    }

    // Jaccard-like: overlap / union size
    const unionSize = new Set([...taskKeywords, ...skillKeywords]).size;
    return unionSize > 0 ? overlap / unionSize : 0;
  }

  /** Compute historical effectiveness score (0-1). */
  private computeEffectivenessScore(skillId: string): number {
    if (!this.scorer) return 0;
    const score = this.scorer.getScore(skillId);
    return score?.score ?? 0;
  }

  /** Tokenize text into lowercase keywords. */
  private tokenize(text: string): Set<string> {
    return new Set(
      text
        .toLowerCase()
        .replace(/[^a-z0-9一-鿿]+/g, " ")
        .split(/\s+/)
        .filter((w) => w.length >= 2)
    );
  }
}
