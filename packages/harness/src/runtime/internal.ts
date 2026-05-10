import type {
  AgentAssignment,
  ArtifactRecord,
  CritiqueResult,
  ExecutionPlan,
  FlowCheckpoint,
  PendingAction,
  PolicyProposal,
  ProposalCategory,
  ProposalSource,
  RuntimeEvent,
  StepResult,
  TaskFlow,
  TaskScope,
  Tool,
} from "@open-vera/core/types";

export interface LegacyChallengeIssue {
  severity: "critical" | "major" | "minor";
  issue: string;
  suggestion: string;
}

export interface LegacyChallengeResult {
  passed: boolean;
  score: number;
  action: "pass" | "reject";
  critiques: LegacyChallengeIssue[];
  verdict: string;
  requiredFixes: string[];
}

export interface MarkdownFlowStepInput {
  index: number;
  name: string;
  dir: string;
  agents: string[];
  inputs: string[];
}

export interface MarkdownFlowInput {
  workspaceRel: string;
  maxRetries: number;
  steps: MarkdownFlowStepInput[];
  rawFlowBody: string;
}

export type TimelineEntry = RuntimeEvent & {
  ts: string;
  detail?: string;
};

export interface ArtifactStore {
  rootDir: string;
  flowDir: string;
}

export interface StartFlowInput {
  flowId: string;
  goal: string;
  plan: ExecutionPlan;
  scope?: TaskScope;
  maxLoops?: number;
}

export interface RuntimeOptions {
  artifactsRootDir: string;
  /**
   * Named agent runners. "default" is used when a step has no assignedAgent.
   * If omitted, HarnessRuntime uses StreamAgentRunner as the default.
   */
  agents?: import("../agent/index.js").AgentRunnerMap;
  /**
   * Directory for checkpoint persistence. If provided, checkpoints are
   * saved as JSONL files and can be used for resume/fork.
   */
  checkpointsDir?: string;
  /**
   * Enable automatic checkpointing at each step boundary.
   * Requires checkpointsDir to be set. Default: true when checkpointsDir is set.
   */
  autoCheckpoint?: boolean;
}

export interface FlowHandle {
  flow: TaskFlow;
  store: ArtifactStore;
}

export interface RunAssignmentOptions {
  tools?: Tool[];
  system?: string;
  maxTurns?: number;
  /** Pre-resolved executors from SkillResolver; if provided, onToolCall is ignored */
  executors?: Map<string, (args: Record<string, unknown>) => Promise<string> | string>;
  onToolCall?: (
    name: string,
    args: Record<string, unknown>
  ) => Promise<string> | string;
}

export interface CreateProposalInput {
  source: ProposalSource;
  category: ProposalCategory;
  hypothesis: string;
  patch: string;
  expectedImpact: string;
  proposalId?: string;
}

export interface CreateCheckpointInput {
  checkpointId: string;
  flow: TaskFlow;
  artifacts: ArtifactRecord[];
}

export interface PlanCritiqueInput {
  plan: ExecutionPlan;
  projectContext: string;
}

export interface ReplanInput {
  plan: ExecutionPlan;
  failedStepId: string;
  critique: CritiqueResult;
  projectContext: string;
}

export interface StepCritiqueInput {
  stepName: string;
  goal: string;
  stepReadme: string;
  customChallengePrompt?: string;
  outputs: Record<string, string>;
}

export interface ApprovalDecision {
  approved: boolean;
  feedback?: string;
}

export interface ApprovalRecord {
  action: PendingAction;
  decision: ApprovalDecision;
  decidedAt: string;
}

export interface JsonCompletionOptions {
  system?: string;
  maxTokens?: number;
}

export interface JsonCompletionResult<T> {
  text: string;
  parsed: T;
}

export interface StepCritiqueArtifact {
  critique: CritiqueResult;
  raw: LegacyChallengeResult;
}

export interface ProposalBundle {
  proposal: PolicyProposal;
  rationale: string;
}

export interface CheckpointBundle {
  checkpoint: FlowCheckpoint;
  artifact: ArtifactRecord;
}

export interface ResumeOptions {
  /** Which step to resume from. Defaults to checkpoint's activeStepId or first non-done step. */
  fromStepId?: string;
  /** Skip completed steps and resume from the next pending step. Default: true */
  skipCompleted?: boolean;
}

export interface ForkOptions {
  /** New flowId for the forked flow */
  newFlowId: string;
  /** Optional new goal. If omitted, keeps the original goal. */
  newGoal?: string;
  /** Optional step IDs to reset to pending (default: keep all status from checkpoint) */
  resetSteps?: string[];
}

export interface AssignmentBundle {
  handle: FlowHandle;
  assignment: AgentAssignment;
}

export interface StepExecutionBundle {
  handle: FlowHandle;
  assignment: AgentAssignment;
  result: StepResult;
}

export type FlowLoopEvent =
  | { type: "step_start"; stepId: string }
  | { type: "step_result"; stepId: string; score: number; passed: boolean; nextAction: string }
  | { type: "step_retry"; stepId: string }
  | { type: "replan"; stepId: string; diff: PlanDiff }
  | { type: "flow_paused"; pausedOnStepId: string };

export interface RunFlowLoopOptions extends RunAssignmentOptions {
  maxSteps?: number;
  stepReadmeByStepId?: Record<string, string>;
  stepPromptByStepId?: Record<string, string>;
  onEvent?: (event: FlowLoopEvent) => void;
}

export interface FlowLoopResult {
  handle: FlowHandle;
  completedSteps: string[];
  failedStepId?: string;
  pausedOnStepId?: string;
}

export interface PlanDiff {
  /** Step ids that were "done" in the original and are preserved unchanged. */
  preserved: string[];
  /** Non-done step ids that existed in both plans but were changed by the LLM. */
  modified: string[];
  /** New step ids introduced by the LLM. */
  added: string[];
  /** Non-done step ids from the original that the LLM dropped. */
  removed: string[];
}
