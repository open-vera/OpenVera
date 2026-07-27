export type PerfEventKind =
  | "longtask"
  | "dropped_frame"
  | "freeze"
  | "timeout"
  | "slow_op"
  | "event_loop_lag";

export type PerfSeverity = "info" | "warn" | "error";

export interface PerfEvent {
  id: string;
  kind: PerfEventKind;
  severity: PerfSeverity;
  /** Wall-clock ms when recorded. */
  ts: number;
  /** Duration / lag / frame gap in ms. */
  durationMs: number;
  /** Short human label, e.g. openRunLog, expandToolProgress. */
  name: string;
  detail?: string;
  meta?: Record<string, string | number | boolean | null>;
}

export interface PerfThresholds {
  /** Long Task API / slow_op soft threshold. */
  longTaskMs: number;
  /** Frame budget before counting a dropped frame (~2 frames @60Hz). */
  droppedFrameMs: number;
  /** Gap that means the UI thread was frozen. */
  freezeMs: number;
  /** setInterval watchdog lag. */
  eventLoopLagMs: number;
  /** Default timeout for measureAsync. */
  defaultTimeoutMs: number;
}

export const DEFAULT_PERF_THRESHOLDS: PerfThresholds = {
  longTaskMs: 50,
  droppedFrameMs: 33,
  freezeMs: 500,
  eventLoopLagMs: 100,
  defaultTimeoutMs: 8_000,
};
