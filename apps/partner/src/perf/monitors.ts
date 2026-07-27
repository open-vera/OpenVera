import { recordPerfEvent, severityForDuration } from "./recorder.js";
import { DEFAULT_PERF_THRESHOLDS, type PerfThresholds } from "./types.js";

let started = false;
let rafId = 0;
let lagTimer: number | undefined;
let lastFrameTs = 0;
let thresholds: PerfThresholds = { ...DEFAULT_PERF_THRESHOLDS };
let longTaskObserver: PerformanceObserver | null = null;

/** Coalesce dropped-frame spam: at most one record per window. */
let lastDroppedFrameAt = 0;
const DROPPED_FRAME_COALESCE_MS = 1_000;

function onAnimationFrame(now: number): void {
  if (lastFrameTs > 0) {
    const gap = now - lastFrameTs;
    if (gap >= thresholds.freezeMs) {
      recordPerfEvent({
        kind: "freeze",
        severity: "error",
        durationMs: Math.round(gap),
        name: "main_thread_freeze",
        detail: `rAF gap ${Math.round(gap)}ms (threshold ${thresholds.freezeMs}ms)`,
      });
    } else if (gap >= thresholds.droppedFrameMs) {
      if (now - lastDroppedFrameAt >= DROPPED_FRAME_COALESCE_MS) {
        lastDroppedFrameAt = now;
        recordPerfEvent({
          kind: "dropped_frame",
          severity: severityForDuration(
            gap,
            thresholds.droppedFrameMs,
            thresholds.freezeMs,
          ),
          durationMs: Math.round(gap),
          name: "animation_frame",
          detail: `frame gap ${Math.round(gap)}ms`,
        });
      }
    }
  }
  lastFrameTs = now;
  rafId = window.requestAnimationFrame(onAnimationFrame);
}

function startLongTaskObserver(): void {
  if (typeof PerformanceObserver === "undefined") return;
  try {
    longTaskObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const duration = entry.duration;
        if (duration < thresholds.longTaskMs) continue;
        recordPerfEvent({
          kind: "longtask",
          severity: severityForDuration(
            duration,
            thresholds.longTaskMs,
            thresholds.freezeMs,
          ),
          durationMs: Math.round(duration),
          name: entry.name || "longtask",
          detail: `Long Task ${Math.round(duration)}ms`,
          meta: {
            startTime: Math.round(entry.startTime),
            entryType: entry.entryType,
          },
        });
      }
    });
    longTaskObserver.observe({
      type: "longtask",
      buffered: true,
    } as PerformanceObserverInit);
  } catch {
    // Safari / older webviews may reject longtask
    longTaskObserver = null;
  }
}

function startEventLoopWatchdog(): void {
  const expected = 250;
  let last = performance.now();
  lagTimer = window.setInterval(() => {
    const now = performance.now();
    const lag = now - last - expected;
    last = now;
    if (lag < thresholds.eventLoopLagMs) return;
    recordPerfEvent({
      kind: "event_loop_lag",
      severity: severityForDuration(lag, thresholds.eventLoopLagMs, thresholds.freezeMs),
      durationMs: Math.round(lag),
      name: "event_loop_watchdog",
      detail: `timer slipped ${Math.round(lag)}ms`,
    });
  }, expected);
}

export function startPerfMonitors(next?: Partial<PerfThresholds>): void {
  if (started) return;
  started = true;
  thresholds = { ...DEFAULT_PERF_THRESHOLDS, ...next };
  startLongTaskObserver();
  startEventLoopWatchdog();
  lastFrameTs = 0;
  rafId = window.requestAnimationFrame(onAnimationFrame);
}

export function stopPerfMonitors(): void {
  if (!started) return;
  started = false;
  if (rafId) {
    window.cancelAnimationFrame(rafId);
    rafId = 0;
  }
  if (lagTimer !== undefined) {
    window.clearInterval(lagTimer);
    lagTimer = undefined;
  }
  longTaskObserver?.disconnect();
  longTaskObserver = null;
  lastFrameTs = 0;
}

/** Visible for unit tests. */
export function classifyFrameGap(
  gapMs: number,
  cfg: PerfThresholds = DEFAULT_PERF_THRESHOLDS,
): "ok" | "dropped_frame" | "freeze" {
  if (gapMs >= cfg.freezeMs) return "freeze";
  if (gapMs >= cfg.droppedFrameMs) return "dropped_frame";
  return "ok";
}
