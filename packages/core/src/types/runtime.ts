// Runtime 协议：Harness / Flow / Plan / Critique / Proposal

import type { Message } from "./message.js";
import type { Usage } from "./completion.js";

export type HarnessState =
  | "intaking"
  | "planning"
  | "dispatching"
  | "executing"
  | "waiting_tool"
  | "waiting_approval"
  | "critiquing"
  | "replanning"
  | "paused"
  | "completed"
  | "failed";

export type RiskLevel = "low" | "medium" | "high";

export type PlanStepType =
  | "analyze"
  | "tool"
  | "delegate"
  | "critique"
  | "finalize";

export type PlanStepStatus =
  | "pending"
  | "running"
  | "done"
  | "failed"
  | "blocked";

export type ProposalCategory =
  | "prompt"
  | "tool_policy"
  | "workflow"
  | "routing";

export type ProposalSource = "critique" | "dreaming" | "benchmark";

export type ProposalStatus =
  | "draft"
  | "reviewing"
  | "approved"
  | "rejected"
  | "rolled_out";

export type ArtifactType =
  | "plan"
  | "step_result"
  | "tool_call"
  | "critique"
  | "retrospective"
  | "checkpoint"
  | "proposal"
  | "benchmark_report"
  | "dream_report";

export type NextAction = "complete" | "replan" | "retry" | "ask_human";

export interface TaskScope {
  workdir?: string;
  allowedDomains?: string[];
  readonlyMode?: boolean;
  budgetTokens?: number;
  budgetUsd?: number;
  deadlineMs?: number;
}

export interface BudgetState {
  tokenBudget?: number;
  usdBudget?: number;
  tokensUsed: number;
  usdUsed?: number;
}

export interface PlanStep {
  id: string;
  type: PlanStepType;
  action: string;
  dependsOn?: string[];
  assignedAgent?: string;
  status: PlanStepStatus;
}

export interface ExecutionPlan {
  planId: string;
  goal: string;
  assumptions: string[];
  steps: PlanStep[];
  risk: RiskLevel;
}

export interface AgentAssignment {
  flowId: string;
  stepId: string;
  goal: string;
  instruction: string;
  allowedTools: string[];
  scope: TaskScope;
  contextSlices: string[];
  /** Named agent runner to use. Matches a key in HarnessRuntime's agentRunners map. */
  assignedAgent?: string;
}

export interface ToolCallRecord {
  id?: string;
  name: string;
  arguments: Record<string, unknown>;
  result: string;
}

export interface StepResult {
  flowId: string;
  stepId: string;
  agentId?: string;
  output: string;
  toolCalls: ToolCallRecord[];
  usage?: Usage;
  messages?: Message[];
}

export interface CritiqueResult {
  confidence: number;
  issues: string[];
  missingChecks: string[];
  nextAction: NextAction;
  rationale: string;
}

export interface RetrospectiveResult {
  strengths: string[];
  mistakes: string[];
  takeaways: string[];
}

export interface PendingAction {
  tool: string;
  args: Record<string, unknown>;
  risk: RiskLevel;
  reason: string;
  reversible: boolean;
}

export interface PolicyProposal {
  proposalId: string;
  source: ProposalSource;
  category: ProposalCategory;
  hypothesis: string;
  patch: string;
  expectedImpact: string;
  status: ProposalStatus;
}

export interface ArtifactRecord {
  id: string;
  type: ArtifactType;
  uri?: string;
  summary?: string;
}

export interface FlowCheckpoint {
  checkpointId: string;
  flowId: string;
  state: HarnessState;
  plan?: ExecutionPlan;
  activeStepId?: string;
  loopCount: number;
  budget: BudgetState;
  scope: TaskScope;
  messages?: Message[];
  artifacts: ArtifactRecord[];
}

export interface TaskFlow {
  flowId: string;
  goal: string;
  state: HarnessState;
  plan?: ExecutionPlan;
  activeStepId?: string;
  loopCount: number;
  maxLoops: number;
  budget: BudgetState;
  scope: TaskScope;
  assignedAgents: string[];
  artifacts: ArtifactRecord[];
}

export type RuntimeEvent =
  | { type: "flow_started"; flowId: string }
  | { type: "batch_started"; flowId: string; stepIds: string[] }
  | { type: "step_dispatched"; flowId: string; stepId: string; agentId: string }
  | { type: "tool_blocked"; flowId: string; tool: string; reason: string }
  | { type: "approval_requested"; flowId: string; action: string }
  | { type: "critique_completed"; flowId: string; confidence: number }
  | { type: "proposal_created"; proposalId: string }
  | { type: "flow_completed"; flowId: string };
