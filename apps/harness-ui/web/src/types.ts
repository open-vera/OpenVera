// Mirrors apps/harness-ui/server/src/types.ts

export type RunStatus = "running" | "completed" | "failed" | "paused";

export interface StepSummary {
  stepId: string;
  status: "pending" | "running" | "done" | "failed";
  score?: number;
  retries: number;
  agents: string[];
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  critique?: {
    confidence: number;
    rationale?: string;
    nextAction?: string;
  };
}

export interface RunSummary {
  runId: string;
  flowDir: string;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  status: RunStatus;
  goal?: string;
  steps: StepSummary[];
  totalSteps: number;
  completedSteps: number;
  failedSteps: number;
  artifactIds: string[];
}

export interface AgentInteraction {
  agent: string;
  adapter?: string;
  prompt?: string;
  response?: string;
  durationMs?: number;
}

export interface StepDetail {
  stepId: string;
  agents: AgentInteraction[];
  critiqueJson?: unknown;
  resultJson?: unknown;
}

export interface FlowTemplate {
  name: string;
  dir: string;
  steps: string[];
}

export interface TimelineEvent {
  ts: string;
  type: string;
  [key: string]: unknown;
}
