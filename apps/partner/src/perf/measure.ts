import { recordPerfEvent, severityForDuration } from "./recorder.js";
import { DEFAULT_PERF_THRESHOLDS } from "./types.js";

export interface MeasureOptions {
  /** Soft threshold → slow_op warn. Defaults to longTaskMs. */
  warnMs?: number;
  /** Hard threshold → slow_op error. Defaults to freezeMs. */
  errorMs?: number;
  /** Fail the promise and record timeout when exceeded. */
  timeoutMs?: number;
  meta?: Record<string, string | number | boolean | null>;
  /** When false, skip recording if under warnMs. Default true only records slow ones. */
  recordOnlySlow?: boolean;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, name: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = globalThis.setTimeout(() => {
      const error = new Error(`Timed out: ${name} (>${timeoutMs}ms)`);
      recordPerfEvent({
        kind: "timeout",
        severity: "error",
        durationMs: timeoutMs,
        name,
        detail: error.message,
      });
      reject(error);
    }, timeoutMs);
    promise.then(
      (value) => {
        globalThis.clearTimeout(timer);
        resolve(value);
      },
      (reason: unknown) => {
        globalThis.clearTimeout(timer);
        reject(reason);
      },
    );
  });
}

/** Measure an async operation; record timeout / slow_op when thresholds exceeded. */
export async function measureAsync<T>(
  name: string,
  work: () => Promise<T>,
  options: MeasureOptions = {},
): Promise<T> {
  const warnMs = options.warnMs ?? DEFAULT_PERF_THRESHOLDS.longTaskMs;
  const errorMs = options.errorMs ?? DEFAULT_PERF_THRESHOLDS.freezeMs;
  const timeoutMs = options.timeoutMs ?? DEFAULT_PERF_THRESHOLDS.defaultTimeoutMs;
  const recordOnlySlow = options.recordOnlySlow !== false;
  const started = performance.now();

  try {
    const result = await withTimeout(Promise.resolve().then(work), timeoutMs, name);
    const durationMs = Math.round(performance.now() - started);
    if (!recordOnlySlow || durationMs >= warnMs) {
      recordPerfEvent({
        kind: "slow_op",
        severity: severityForDuration(durationMs, warnMs, errorMs),
        durationMs,
        name,
        detail: `${name} took ${durationMs}ms`,
        ...(options.meta ? { meta: options.meta } : {}),
      });
    }
    return result;
  } catch (error) {
    const durationMs = Math.round(performance.now() - started);
    if (!(error instanceof Error && error.message.startsWith("Timed out:"))) {
      recordPerfEvent({
        kind: "slow_op",
        severity: "error",
        durationMs,
        name,
        detail: error instanceof Error ? error.message : String(error),
        ...(options.meta ? { meta: { ...options.meta, failed: true } } : { meta: { failed: true } }),
      });
    }
    throw error;
  }
}

/** Measure a sync block (e.g. heavy expand). */
export function measureSync<T>(
  name: string,
  work: () => T,
  options: Omit<MeasureOptions, "timeoutMs"> = {},
): T {
  const warnMs = options.warnMs ?? DEFAULT_PERF_THRESHOLDS.longTaskMs;
  const errorMs = options.errorMs ?? DEFAULT_PERF_THRESHOLDS.freezeMs;
  const recordOnlySlow = options.recordOnlySlow !== false;
  const started = performance.now();
  try {
    return work();
  } finally {
    const durationMs = Math.round(performance.now() - started);
    if (!recordOnlySlow || durationMs >= warnMs) {
      recordPerfEvent({
        kind: "slow_op",
        severity: severityForDuration(durationMs, warnMs, errorMs),
        durationMs,
        name,
        detail: `${name} took ${durationMs}ms`,
        ...(options.meta ? { meta: options.meta } : {}),
      });
    }
  }
}
