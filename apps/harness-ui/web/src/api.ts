import type {
  RunSummary,
  StepDetail,
  FlowTemplate,
  TimelineEvent,
} from "./types";

const BASE = "/api";

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json() as Promise<T>;
}

export const api = {
  runs: {
    list: () => get<RunSummary[]>("/runs"),
    get: (runId: string) => get<RunSummary>(`/runs/${runId}`),
    timeline: (runId: string) => get<TimelineEvent[]>(`/runs/${runId}/timeline`),
    step: (runId: string, stepId: string) =>
      get<StepDetail>(`/runs/${runId}/steps/${stepId}`),
    artifact: (runId: string, artifactId: string) =>
      get<unknown>(`/runs/${runId}/artifacts/${artifactId}`),
    spawn: (body: {
      flowDir?: string;
      model?: string;
      skipPlanCritique?: boolean;
    }) =>
      fetch(`${BASE}/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }).then((r) => r.json() as Promise<{ runId: string; startedAt: string }>),
  },
  flows: {
    list: () => get<FlowTemplate[]>("/flows"),
  },
};

/** Open an SSE connection to /api/runs/:runId/stream */
export function openStream(
  runId: string,
  onEvent: (ev: TimelineEvent) => void,
  onDone: () => void
): () => void {
  const es = new EventSource(`${BASE}/runs/${runId}/stream`);

  es.onmessage = (e) => {
    try {
      onEvent(JSON.parse(e.data) as TimelineEvent);
    } catch {
      // ignore malformed
    }
  };

  es.addEventListener("done", () => {
    onDone();
    es.close();
  });

  es.onerror = () => {
    onDone();
    es.close();
  };

  return () => es.close();
}
