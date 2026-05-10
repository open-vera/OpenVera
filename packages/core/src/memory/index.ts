export { MemoryTracker } from "./tracker.js";
export type { MemoryTrackerOptions } from "./tracker.js";

export { scanMemoryDir } from "./scanner.js";
export { detectUsage, extractKeywords, memoryKeywords } from "./detector.js";

export type {
  MemoryFile,
  MemoryType,
  InjectionRecord,
  UsageDetectionResult,
  MemoryHitStats,
  DetectorConfig,
} from "./types.js";
export { DEFAULT_DETECTOR_CONFIG } from "./types.js";

export { MemoryStore } from "./store.js";
export type {
  MemoryEntry,
  EpisodicEntry,
  SemanticEntry,
  MemoryStoreOptions,
  MemorySearchResult,
  MemoryTier,
} from "./store.js";
