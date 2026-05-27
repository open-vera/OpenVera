export interface RunSummary {
  runId: string;
  status: 'running' | 'completed' | 'failed' | 'paused';
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  goal?: string;
  totalSteps: number;
  completedSteps: number;
  failedSteps: number;
}

export interface RunDetail {
  runId: string;
  flowDir: string;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  status: 'running' | 'completed' | 'failed' | 'paused';
  goal?: string;
  steps: Array<{
    stepId: string;
    status: 'pending' | 'running' | 'done' | 'failed';
    score?: number;
    retries: number;
    startedAt?: string;
    endedAt?: string;
    durationMs?: number;
  }>;
  totalSteps: number;
  completedSteps: number;
  failedSteps: number;
}

export interface MemoryEntry {
  id: string;
  tier: 'episodic' | 'semantic' | 'working';
  content: string;
  tags: string[];
  createdAt: string;
  importance: number;
  source: string;
}

export interface MemorySnapshot {
  episodicCount: number;
  semanticCount: number;
  workingCount: number;
}

export interface MemoryResponse {
  snapshot: MemorySnapshot;
  entries: MemoryEntry[];
  total: number;
}

export interface Checkpoint {
  checkpointId: string;
  flowId: string;
  state: string;
  createdAt: string;
  activeStepId: string;
}

export interface SubagentPoolStatus {
  totalSlots: number;
  activeAgents: number;
  queuedTasks: number;
}

export interface SubagentCallTreeNode {
  taskId: string;
  agentType: string;
  status: 'pending' | 'running' | 'done' | 'failed';
  dependsOn?: string[];
  children?: SubagentCallTreeNode[];
}

export interface SubagentResponse {
  poolStatus: SubagentPoolStatus;
  callTree: SubagentCallTreeNode[];
}

const API_BASE = '/api';

async function fetch<T>(url: string, options?: RequestInit): Promise<T> {
  const response: Response = await fetch(`${API_BASE}${url}`, options);
  if (!response.ok) {
    throw new Error(`API request failed: ${response.statusText}`);
  }
  return response.json() as Promise<T>;
}

export async function fetchRuns(): Promise<RunSummary[]> {
  return fetch<RunSummary[]>('/runs');
}

export async function fetchRun(runId: string): Promise<RunDetail> {
  return fetch<RunDetail>(`/runs/${runId}`);
}

export async function fetchMemory(
  runId: string,
  tier?: 'episodic' | 'semantic' | 'working',
  search?: string
): Promise<MemoryResponse> {
  const params = new URLSearchParams();
  if (tier) params.append('tier', tier);
  if (search) params.append('search', search);

  const queryString = params.toString() ? `?${params.toString()}` : '';
  return fetch<MemoryResponse>(`/runs/${runId}/memory${queryString}`);
}

export async function fetchCheckpoints(runId: string): Promise<Checkpoint[]> {
  return fetch<Checkpoint[]>(`/runs/${runId}/checkpoints`);
}

export async function fetchSubagents(runId: string): Promise<SubagentResponse> {
  return fetch<SubagentResponse>(`/runs/${runId}/subagents`);
}
