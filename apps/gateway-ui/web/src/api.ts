export type CapabilityKind =
  | "config"
  | "provider"
  | "model"
  | "prompt"
  | "context"
  | "memory"
  | "rag"
  | "skill"
  | "plugin"
  | "mcp"
  | "channel"
  | "sandbox"
  | "flow"
  | "conversation"
  | "tool"
  | "log"
  | "cost";

export interface GatewayOverview {
  generatedAt: string;
  roots: string[];
  projectCount: number;
  capabilityCount: number;
  capabilitySummary: Record<string, number>;
  doctorStatus: "pass" | "warn" | "fail";
}

export interface GatewayProject {
  id: string;
  name: string;
  rootDir: string;
  veraDir: string;
  flowsDir: string;
  source: "explicit" | "discovered";
}

export interface ProjectDetail extends GatewayProject {
  capabilities: CapabilityDescriptor[];
  activity?: ProjectActivity;
}

export interface CapabilityDescriptor {
  id: string;
  kind: CapabilityKind;
  name: string;
  status: "available" | "disabled" | "error" | "unknown";
  scope: "global" | "project" | "session" | "run";
  source: string;
  projectId?: string;
  configPath?: string;
  health?: { ok: boolean; message?: string; checkedAt: string };
  actions: string[];
  metadata: Record<string, unknown>;
}

export interface DoctorCheck {
  id: string;
  label: string;
  status: "pass" | "warn" | "fail";
  scope: "gateway" | "project" | "capability";
  message: string;
  projectId?: string;
  capabilityId?: string;
  details: Record<string, unknown>;
}

export interface DoctorReport {
  generatedAt: string;
  status: "pass" | "warn" | "fail";
  checks: DoctorCheck[];
}

export interface RunSummary {
  runId: string;
  projectId: string;
  projectName: string;
  status: "running" | "completed" | "failed" | "paused";
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  goal?: string;
  totalSteps: number;
  completedSteps: number;
  failedSteps: number;
  costUsd: number;
}

export interface StepSummary {
  stepId: string;
  status: "pending" | "running" | "done" | "failed";
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  agents: string[];
  retries: number;
  score?: number;
}

export interface TimelineEvent {
  ts?: string;
  type?: string;
  [key: string]: unknown;
}

export interface RunDetail extends RunSummary {
  projectId: string;
  projectName: string;
  runDir: string;
  timeline: TimelineEvent[];
  steps: StepSummary[];
  artifactIds: string[];
}

export interface FlowTemplate {
  name: string;
  dir: string;
  projectId: string;
  projectName: string;
  description?: string;
  steps: string[];
}

export interface ConversationMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: string;
}

export interface Conversation {
  id: string;
  projectId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: ConversationMessage[];
}

export interface MemoryEntry {
  id: string;
  tier: "episodic" | "semantic" | "working";
  content: string;
  tags: string[];
  createdAt: string;
  importance: number;
  source: string;
}

export interface MemoryResponse {
  snapshot: { episodicCount: number; semanticCount: number; workingCount: number };
  entries: MemoryEntry[];
  total: number;
}

export interface CheckpointIndex {
  checkpointId: string;
  flowId: string;
  state: string;
  createdAt: string;
  activeStepId: string;
  raw: unknown;
}

export interface SubagentResponse {
  poolStatus: { totalSlots: number; activeAgents: number; queuedTasks: number };
  callTree: unknown[];
}

export interface HostResources {
  cpu: { cores: number; loadPercent: number };
  memory: { totalBytes: number; usedBytes: number; usedPercent: number };
  disk: { totalBytes: number; usedBytes: number; usedPercent: number };
}

export interface ProjectActivity {
  projectId: string;
  name: string;
  rootDir: string;
  status: "idle" | "running" | "paused";
  activeRunId: string | null;
  runCount: number;
  lastRunAt: string | null;
}

export interface OperationsSummary {
  projectCount: number;
  runningRuns: number;
  completedRuns: number;
  failedRuns: number;
  host: HostResources;
  projects: ProjectActivity[];
}

export interface ActivityBucket {
  hour: number;
  runStarts: number;
}

export interface CostSummary {
  currency: "USD";
  totalUsd: number;
  runCount: number;
  byRun: Array<{ runId: string; costUsd: number; startedAt: string; status: RunSummary["status"] }>;
}

export interface ActionResult {
  action: string;
  status: "accepted" | "simulated";
  message: string;
  requestedAt: string;
  projectId?: string;
  target?: string;
  artifactIds: string[];
  traceId: string;
  data?: Record<string, unknown>;
}

export interface SpawnRunRequest {
  projectId?: string;
  flowDir?: string;
  model?: string;
  provider?: string;
  skipPlanCritique?: boolean;
  maxSteps?: number;
}

export interface SpawnRunResponse {
  runId: string;
  startedAt: string;
}

export interface RagSearchHit {
  path: string;
  snippet: string;
  score: number;
}

export interface RagSearchResult {
  query: string;
  hits: RagSearchHit[];
  mode: "vector" | "keyword" | "empty";
  message?: string;
}

export interface McpServerSummary {
  id: string;
  name: string;
  transport?: string;
  source: string;
}

export interface McpToolSummary {
  serverId: string;
  name: string;
  description?: string;
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status} ${response.statusText}`);
  }
  return response.json() as Promise<T>;
}

export const gatewayApi = {
  overview: () => getJson<GatewayOverview>("/api/gateway/overview"),
  doctor: () => getJson<DoctorReport>("/api/gateway/doctor"),
  operations: {
    summary: () => getJson<OperationsSummary>("/api/gateway/operations/summary"),
    resources: () => getJson<HostResources>("/api/gateway/operations/resources"),
    activity: () => getJson<ActivityBucket[]>("/api/gateway/operations/activity"),
  },
  projects: {
    list: () => getJson<GatewayProject[]>("/api/projects"),
    get: (projectId: string) => getJson<ProjectDetail>(`/api/projects/${projectId}`),
    capabilities: (projectId: string) =>
      getJson<CapabilityDescriptor[]>(`/api/projects/${projectId}/capabilities`),
  },
  capabilities: (kind?: CapabilityKind) => {
    const query = kind ? `?kind=${encodeURIComponent(kind)}` : "";
    return getJson<CapabilityDescriptor[]>(`/api/capabilities${query}`);
  },
  flows: (projectId?: string) => {
    const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
    return getJson<FlowTemplate[]>(`/api/flows${query}`);
  },
  conversations: {
    list: (projectId?: string) => {
      const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
      return getJson<Conversation[]>(`/api/conversations${query}`);
    },
    get: (conversationId: string) => getJson<Conversation>(`/api/conversations/${conversationId}`),
    create: async (projectId: string, title?: string) => {
      const response = await fetch("/api/conversations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId, title }),
      });
      if (!response.ok) throw new Error(`Create conversation failed: ${response.statusText}`);
      return response.json() as Promise<Conversation>;
    },
    sendMessage: async (conversationId: string, content: string) => {
      const response = await fetch(`/api/conversations/${conversationId}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ role: "user", content }),
      });
      if (!response.ok) throw new Error(`Send message failed: ${response.statusText}`);
      return response.json() as Promise<{ message: ConversationMessage; conversation: Conversation }>;
    },
  },
  runs: {
    list: (projectId?: string) => {
      const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
      return getJson<RunSummary[]>(`/api/runs${query}`);
    },
    get: (runId: string) => getJson<RunDetail>(`/api/runs/${runId}`),
    spawn: async (body: SpawnRunRequest) => {
      const response = await fetch("/api/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(`Spawn failed: ${response.statusText}`);
      return response.json() as Promise<SpawnRunResponse>;
    },
    memory: (runId: string, tier?: string, search?: string) => {
      const params = new URLSearchParams();
      if (tier) params.set("tier", tier);
      if (search) params.set("search", search);
      const query = params.toString() ? `?${params.toString()}` : "";
      return getJson<MemoryResponse>(`/api/runs/${runId}/memory${query}`);
    },
    checkpoints: (runId: string) => getJson<CheckpointIndex[]>(`/api/runs/${runId}/checkpoints`),
    subagents: (runId: string) => getJson<SubagentResponse>(`/api/runs/${runId}/subagents`),
    artifact: (runId: string, artifactId: string) =>
      getJson<unknown>(`/api/runs/${runId}/artifacts/${artifactId}`),
  },
  cost: () => getJson<CostSummary>("/api/cost"),
  rag: {
    search: (projectId: string, q: string) =>
      getJson<RagSearchResult>(`/api/projects/${projectId}/rag/search?q=${encodeURIComponent(q)}`),
  },
  mcp: {
    servers: (projectId: string) => getJson<McpServerSummary[]>(`/api/projects/${projectId}/mcp/servers`),
    tools: (projectId: string) => getJson<McpToolSummary[]>(`/api/projects/${projectId}/mcp/tools`),
  },
  manage: async (action: string, payload: Record<string, unknown> = {}) => {
    const response = await fetch(`/api/manage/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!response.ok) throw new Error(`Management action failed: ${response.statusText}`);
    return response.json() as Promise<ActionResult>;
  },
  execute: async (action: string, payload: Record<string, unknown> = {}) => {
    const response = await fetch(`/api/execute/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!response.ok) throw new Error(`Execution action failed: ${response.statusText}`);
    return response.json() as Promise<ActionResult>;
  },
};
