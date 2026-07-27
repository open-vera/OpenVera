export type { PerfEvent, PerfEventKind, PerfSeverity, PerfThresholds } from "./types.js";
export { DEFAULT_PERF_THRESHOLDS } from "./types.js";
export {
  buildPerfLogPath,
  getPerfLogRoot,
  getRecentPerfEvents,
  recordPerfEvent,
  resetPerfRecorderForTests,
  setPerfLogRoot,
  subscribePerfEvents,
} from "./recorder.js";
export { classifyFrameGap, startPerfMonitors, stopPerfMonitors } from "./monitors.js";
export { measureAsync, measureSync, type MeasureOptions } from "./measure.js";

import { startPerfMonitors } from "./monitors.js";

/** Boot global monitors once from main.ts. */
export function installPartnerPerf(): void {
  startPerfMonitors();
}
