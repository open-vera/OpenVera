export interface AdminOverview {
  total_spaces: number;
  active_tasks: number;
  total_containers: number;
  resource_usage: {
    cpu: number;
    memory: number;
    disk: number;
  };
}

export interface AdminContainer {
  scope_id: string;
  type: 'group' | 'user';
  busy: boolean;
  running_task_id?: string;
}

export interface AdminResource {
  type: string;
  usage: number;
  total: number;
}

export interface AdminSpaceDetail {
  scope_id: string;
  type: 'group' | 'user';
  busy: boolean;
  running_task?: {
    task_id: string;
    prompt: string;
    started_at: string;
  };
  stats?: {
    memory_entries: number;
    checkpoints: number;
    subagents: number;
  };
}

export interface HeatmapData {
  hour: number;
  active: number;
  idle: number;
}

const API_BASE = '/api/admin';

async function fetch<T>(url: string, options?: RequestInit): Promise<T> {
  const response: Response = await fetch(`${API_BASE}${url}`, options);
  if (!response.ok) {
    throw new Error(`API request failed: ${response.statusText}`);
  }
  return response.json() as Promise<T>;
}

export async function fetchOverview(): Promise<AdminOverview> {
  return fetch<AdminOverview>('/overview');
}

export async function fetchContainers(): Promise<AdminContainer[]> {
  return fetch<AdminContainer[]>('/containers');
}

export async function fetchResources(): Promise<AdminResource[]> {
  return fetch<AdminResource[]>('/resources');
}

export async function fetchSpaces(): Promise<AdminSpaceDetail[]> {
  return fetch<AdminSpaceDetail[]>('/spaces');
}

export async function fetchSpaceDetail(scopeId: string): Promise<AdminSpaceDetail> {
  return fetch<AdminSpaceDetail>(`/spaces/${scopeId}`);
}

export async function fetchHeatmap(): Promise<HeatmapData[]> {
  return fetch<HeatmapData[]>('/heatmap');
}
