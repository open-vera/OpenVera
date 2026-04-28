// ── Timeline event shapes ─────────────────────────────────────────────────────
// Supports both new harness (flow_started / step_dispatched / critique_completed)
// and old demo format (step_start / agent_call / eval / step_done).

export interface TimelineEvent {
  ts: string;
  type: string;
  [key: string]: unknown;
}

// ── Per-step aggregation ──────────────────────────────────────────────────────

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

// ── Run-level aggregation ─────────────────────────────────────────────────────

export type RunStatus = "running" | "completed" | "failed" | "paused";

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

// ── Step detail (for GET /api/runs/:id/steps/:stepId) ────────────────────────

export interface StepDetail {
  stepId: string;
  agents: AgentInteraction[];
  critiqueJson?: unknown;
  resultJson?: unknown;
}

export interface AgentInteraction {
  agent: string;
  adapter?: string;
  prompt?: string;
  response?: string;
  durationMs?: number;
}

// ── Flow template (for GET /api/flows) ───────────────────────────────────────

export interface FlowTemplate {
  name: string;
  dir: string;
  description?: string;
  steps: string[];
}

// ── Server context ────────────────────────────────────────────────────────────

export interface ServerContext {
  /** Root directory that contains .flow/ — can be a project dir or a flow-examples subdir */
  flowDir: string;
  /** Directory under flowDir/.flow/iterations/ */
  iterationsDir: string;
  /** Directory to scan for flow-example templates */
  examplesDir?: string;
  port: number;
}
