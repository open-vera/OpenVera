/**
 * Proposal 模块类型定义 — 独立于 dreaming 模块。
 * 与 @open-vera/harness-dreaming 的 ImprovementProposal 保持结构兼容。
 */

export type ProposalType = "prompt" | "tool_policy" | "workflow" | "skill";
export type ProposalPriority = "low" | "medium" | "high" | "critical";
export type ProposalStatus = "pending" | "approved" | "rejected" | "deferred" | "applied";

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
