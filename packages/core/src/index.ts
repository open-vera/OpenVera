// Library entry for @open-vera/core — re-exports only, NO side effects.
//
// This module is imported by other packages (e.g. @open-vera/openvera). It must
// stay free of top-level execution so that importing it never triggers config
// loading, intent routing, agent runs, or REPL startup. The executable CLI lives
// in `main.ts` (run via `tsx src/main.ts`).
export { MemoryTracker } from "./memory/index.js";
export * from "./project-context/index.js";
export type {
  MemoryFile,
  MemoryType,
  MemoryHitStats,
  UsageDetectionResult,
} from "./memory/index.js";
export { PlannerError } from "./errors.js";
export * from "./storage/index.js";
export * from "./rag/index.js";
export * from "./channel/index.js";
export * from "./sandbox/index.js";
export * from "./skill-evolution/index.js";
export { createLogger } from "./utils/logger.js";
export type { Logger, LogLevel } from "./utils/logger.js";
