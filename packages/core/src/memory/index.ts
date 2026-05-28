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
  MemoryOrganizeResult,
  MemoryCompressionResult,
  DecayConfig,
} from "./store.js";
export { DEFAULT_DECAY_CONFIG } from "./store.js";

export { MemoryGraph } from "./graph.js";
export type {
  MemoryRelation,
  GraphNode,
  RelatedMemory,
  GraphBuildOptions,
} from "./graph.js";

export { MemoryUpdater } from "./memory-updater.js";
export type {
  MemoryUpdaterOptions,
  MemoryUpdateResult,
} from "./memory-updater.js";

export { runMergeStrategy, parseMergeResponse } from "./merge-strategy.js";
export type {
  MergeDecision,
  MergeStrategyResult,
} from "./merge-strategy.js";

export { TopicOrganizer } from "./topic-organizer.js";
export type {
  TopicOrganizerOptions,
  TopicFile,
  TopicMemoryEntry,
} from "./topic-organizer.js";
