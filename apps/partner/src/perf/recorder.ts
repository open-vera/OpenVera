import { appendFile } from "@/bridge";
import type { PerfEvent, PerfSeverity } from "./types.js";

const RING_SIZE = 400;
const FLUSH_BATCH = 20;
const LOCAL_STORAGE_KEY = "partner:perf-events";
const LOCAL_STORAGE_MAX = 80;

const ring: PerfEvent[] = [];
let logRoot: string | null = null;
let pendingPersist: PerfEvent[] = [];
let persistTimer: number | undefined;
let seq = 0;

type Listener = (event: PerfEvent) => void;
const listeners = new Set<Listener>();

function todayStamp(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

export function buildPerfLogPath(rootPath: string, date = new Date()): string {
  const normalized = rootPath.replace(/\/$/, "");
  return `${normalized}/.vera/partner-perf/${todayStamp(date)}.jsonl`;
}

export function setPerfLogRoot(rootPath: string | null | undefined): void {
  logRoot = rootPath?.trim() ? rootPath.replace(/\/$/, "") : null;
  if (logRoot && pendingPersist.length) {
    schedulePersist();
  }
}

export function getPerfLogRoot(): string | null {
  return logRoot;
}

export function getRecentPerfEvents(limit = 100): PerfEvent[] {
  if (limit >= ring.length) return [...ring];
  return ring.slice(ring.length - limit);
}

export function subscribePerfEvents(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function pushLocalStorage(event: PerfEvent): void {
  try {
    const storage = globalThis.localStorage;
    if (!storage) return;
    const raw = storage.getItem(LOCAL_STORAGE_KEY);
    const list: PerfEvent[] = raw ? (JSON.parse(raw) as PerfEvent[]) : [];
    list.push(event);
    while (list.length > LOCAL_STORAGE_MAX) {
      list.shift();
    }
    storage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(list));
  } catch {
    // ignore quota / private mode
  }
}

function schedulePersist(): void {
  if (persistTimer !== undefined) return;
  persistTimer = globalThis.setTimeout(() => {
    persistTimer = undefined;
    void flushPersist();
  }, 400) as unknown as number;
}

async function flushPersist(): Promise<void> {
  if (!logRoot || pendingPersist.length === 0) return;
  const batch = pendingPersist.splice(0, FLUSH_BATCH);
  const path = buildPerfLogPath(logRoot);
  const payload = `${batch.map((item) => JSON.stringify(item)).join("\n")}\n`;
  try {
    await appendFile(path, payload);
  } catch (error) {
    // Put back and keep localStorage copy as fallback.
    pendingPersist.unshift(...batch);
    console.warn("[Perf] failed to append perf log:", error);
    return;
  }
  if (pendingPersist.length) {
    schedulePersist();
  }
}

export function recordPerfEvent(
  partial: Omit<PerfEvent, "id" | "ts"> & { ts?: number; id?: string },
): PerfEvent {
  const event: PerfEvent = {
    id: partial.id ?? `perf-${Date.now().toString(36)}-${++seq}`,
    ts: partial.ts ?? Date.now(),
    kind: partial.kind,
    severity: partial.severity,
    durationMs: partial.durationMs,
    name: partial.name,
    ...(partial.detail ? { detail: partial.detail } : {}),
    ...(partial.meta ? { meta: partial.meta } : {}),
  };

  ring.push(event);
  while (ring.length > RING_SIZE) {
    ring.shift();
  }

  pendingPersist.push(event);
  pushLocalStorage(event);
  schedulePersist();

  if (event.severity === "error") {
    console.error(`[Perf:${event.kind}] ${event.name} ${event.durationMs}ms`, event.detail ?? "");
  } else if (event.severity === "warn") {
    console.warn(`[Perf:${event.kind}] ${event.name} ${event.durationMs}ms`, event.detail ?? "");
  }

  for (const listener of listeners) {
    try {
      listener(event);
    } catch {
      // ignore listener failures
    }
  }

  return event;
}

export function severityForDuration(
  durationMs: number,
  warnAt: number,
  errorAt: number,
): PerfSeverity {
  if (durationMs >= errorAt) return "error";
  if (durationMs >= warnAt) return "warn";
  return "info";
}

/** Test helper */
export function resetPerfRecorderForTests(): void {
  ring.length = 0;
  pendingPersist = [];
  logRoot = null;
  seq = 0;
  if (persistTimer !== undefined) {
    globalThis.clearTimeout(persistTimer);
    persistTimer = undefined;
  }
  listeners.clear();
}
