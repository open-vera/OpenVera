/**
 * Dreaming Runner — Asynchronous experience distillation and improvement suggestion.
 *
 * "Dreaming" runs during agent idle time to analyze past experiences
 * (episodic memory, benchmark failures) and generate actionable improvement proposals.
 */

// ── Types ────────────────────────────────────────────────────────────────────

export type ProposalType = "prompt" | "tool_policy" | "workflow" | "skill";

export type ProposalPriority = "low" | "medium" | "high" | "critical";

export type ProposalStatus = "pending" | "approved" | "rejected" | "deferred" | "applied";

export interface Experience {
  id: string;
  type: "success" | "failure" | "partial";
  taskDescription: string;
  toolCalls: string[];
  duration: number;
  outcome: string;
  metadata?: Record<string, unknown>;
}

export interface Insight {
  id: string;
  category: "pattern" | "anti_pattern" | "optimization" | "gap";
  description: string;
  evidence: string[];
  confidence: number;
  experiences: string[];
}

export interface ImprovementProposal {
  id: string;
  type: ProposalType;
  priority: ProposalPriority;
  status: ProposalStatus;
  title: string;
  description: string;
  rationale: string;
  insights: string[];
  suggestedChange: string;
  expectedImpact: string;
  createdAt: string;
}

export interface DreamingResult {
  insights: Insight[];
  proposals: ImprovementProposal[];
  experiencesAnalyzed: number;
  duration: number;
}

export interface DreamingConfig {
  /** Maximum experiences to analyze per run */
  maxExperiences?: number;
  /** Minimum confidence for insights */
  minConfidence?: number;
  /** Maximum proposals to generate */
  maxProposals?: number;
  /** Types of proposals to generate */
  proposalTypes?: ProposalType[];
}

// ── Dreaming Runner ──────────────────────────────────────────────────────────

export class DreamingRunner {
  private config: Required<DreamingConfig>;

  constructor(config?: DreamingConfig) {
    this.config = {
      maxExperiences: config?.maxExperiences ?? 100,
      minConfidence: config?.minConfidence ?? 0.5,
      maxProposals: config?.maxProposals ?? 10,
      proposalTypes: config?.proposalTypes ?? ["prompt", "tool_policy", "workflow", "skill"],
    };
  }

  /**
   * Run dreaming: analyze experiences, extract insights, generate proposals.
   */
  async dream(experiences: Experience[]): Promise<DreamingResult> {
    const startTime = Date.now();
    const limited = experiences.slice(0, this.config.maxExperiences);

    const insights = this.extractInsights(limited);
    const filteredInsights = insights.filter((i) => i.confidence >= this.config.minConfidence);
    const proposals = this.generateProposals(filteredInsights);

    return {
      insights: filteredInsights,
      proposals,
      experiencesAnalyzed: limited.length,
      duration: Date.now() - startTime,
    };
  }

  /**
   * Analyze experiences to find patterns.
   */
  extractInsights(experiences: Experience[]): Insight[] {
    const insights: Insight[] = [];

    // Pattern: successful tool combinations
    const successPatterns = this.findToolPatterns(experiences, "success");
    insights.push(...successPatterns);

    // Anti-pattern: failing tool combinations
    const failurePatterns = this.findToolPatterns(experiences, "failure");
    insights.push(...failurePatterns);

    // Optimization: slow tasks that could be improved
    const optimizations = this.findSlowTasks(experiences);
    insights.push(...optimizations);

    // Gap: tasks that failed entirely
    const gaps = this.findGaps(experiences);
    insights.push(...gaps);

    return insights;
  }

  /**
   * Generate improvement proposals from insights.
   */
  generateProposals(insights: Insight[]): ImprovementProposal[] {
    const proposals: ImprovementProposal[] = [];
    let id = 1;

    for (const insight of insights) {
      if (proposals.length >= this.config.maxProposals) break;

      const proposal = this.insightToProposal(insight, id);
      if (proposal && this.config.proposalTypes.includes(proposal.type)) {
        proposals.push(proposal);
        id++;
      }
    }

    return proposals;
  }

  // ── Internal ─────────────────────────────────────────────────────────────

  private findToolPatterns(experiences: Experience[], type: "success" | "failure"): Insight[] {
    const patterns = new Map<string, { count: number; ids: string[] }>();

    for (const exp of experiences) {
      if (exp.type !== type) continue;
      const key = exp.toolCalls.sort().join("+");
      if (key.length === 0) continue;

      const existing = patterns.get(key) ?? { count: 0, ids: [] };
      existing.count++;
      existing.ids.push(exp.id);
      patterns.set(key, existing);
    }

    const insights: Insight[] = [];
    for (const [tools, data] of patterns) {
      if (data.count < 2) continue; // Need at least 2 occurrences
      insights.push({
        id: `pattern-${type}-${insights.length}`,
        category: type === "success" ? "pattern" : "anti_pattern",
        description: `Tool combination [${tools}] ${type === "success" ? "succeeds" : "fails"} consistently (${data.count} times)`,
        evidence: data.ids,
        confidence: Math.min(0.9, data.count / 10 + 0.3),
        experiences: data.ids,
      });
    }

    return insights;
  }

  private findSlowTasks(experiences: Experience[]): Insight[] {
    const durations = experiences.map((e) => e.duration);
    if (durations.length === 0) return [];

    const avg = durations.reduce((a, b) => a + b, 0) / durations.length;
    const threshold = avg * 2; // 2x average is "slow"

    const slowOnes = experiences.filter((e) => e.duration > threshold);
    if (slowOnes.length === 0) return [];

    return [{
      id: "optimization-slow-tasks",
      category: "optimization",
      description: `${slowOnes.length} tasks took >2x average duration (${threshold.toFixed(0)}ms threshold)`,
      evidence: slowOnes.map((e) => `${e.id}: ${e.duration}ms`),
      confidence: 0.7,
      experiences: slowOnes.map((e) => e.id),
    }];
  }

  private findGaps(experiences: Experience[]): Insight[] {
    const failures = experiences.filter((e) => e.type === "failure");
    if (failures.length === 0) return [];

    // Group by tool combination
    const byTools = new Map<string, Experience[]>();
    for (const f of failures) {
      const key = f.toolCalls.sort().join("+") || "no-tools";
      const list = byTools.get(key) ?? [];
      list.push(f);
      byTools.set(key, list);
    }

    const insights: Insight[] = [];
    for (const [tools, exps] of byTools) {
      if (exps.length < 2) continue;
      insights.push({
        id: `gap-${insights.length}`,
        category: "gap",
        description: `Repeated failures with tool set [${tools}] — may need new capability`,
        evidence: exps.map((e) => `${e.id}: ${e.outcome.slice(0, 100)}`),
        confidence: Math.min(0.85, exps.length / 5 + 0.4),
        experiences: exps.map((e) => e.id),
      });
    }

    return insights;
  }

  private insightToProposal(insight: Insight, id: number): ImprovementProposal | null {
    switch (insight.category) {
      case "pattern":
        return {
          id: `proposal-${id}`,
          type: "workflow",
          priority: "medium",
          status: "pending",
          title: `Leverage successful tool pattern`,
          description: insight.description,
          rationale: `This tool combination has been consistently successful.`,
          insights: [insight.id],
          suggestedChange: `Create a skill or workflow template that chains these tools.`,
          expectedImpact: "Improved task completion speed and reliability",
          createdAt: new Date().toISOString(),
        };

      case "anti_pattern":
        return {
          id: `proposal-${id}`,
          type: "tool_policy",
          priority: "high",
          status: "pending",
          title: `Avoid problematic tool combination`,
          description: insight.description,
          rationale: `This tool combination has been consistently failing.`,
          insights: [insight.id],
          suggestedChange: `Add warning or alternative strategy when this tool combination is attempted.`,
          expectedImpact: "Reduced failure rate",
          createdAt: new Date().toISOString(),
        };

      case "optimization":
        return {
          id: `proposal-${id}`,
          type: "prompt",
          priority: "low",
          status: "pending",
          title: `Optimize slow task execution`,
          description: insight.description,
          rationale: "Some tasks take significantly longer than average.",
          insights: [insight.id],
          suggestedChange: "Add time-awareness to prompts or implement early termination.",
          expectedImpact: "Reduced average task duration",
          createdAt: new Date().toISOString(),
        };

      case "gap":
        return {
          id: `proposal-${id}`,
          type: "skill",
          priority: "critical",
          status: "pending",
          title: `Address capability gap`,
          description: insight.description,
          rationale: "Repeated failures indicate a missing capability.",
          insights: [insight.id],
          suggestedChange: "Develop a new skill or tool to handle this task type.",
          expectedImpact: "Enable previously impossible tasks",
          createdAt: new Date().toISOString(),
        };

      default:
        return null;
    }
  }
}
