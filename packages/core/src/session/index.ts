export { SessionStore } from "./store.js";
export { projectSlug, projectsDir } from "./store-paths.js";
export { SessionManager } from "./session-manager.js";
export { generateSessionTitle } from "./title.js";
export {
  calculateCost,
  accumulateCost,
  normalizeModelKey,
  emptyAccumulatedCost,
  emptyUsage,
} from "./cost.js";
export type { SessionStoreBackend, BackendOptions } from "./backend.js";
// Type-only: a value re-export would eagerly evaluate better-sqlite3 (a CJS
// native addon) for every consumer of this barrel, which breaks ESM bundles.
// Load the class through `import("./sqlite-backend.js")` instead — see
// configureSqliteBackend in ./session-backend.ts.
export type { SQLiteSessionBackend } from "./sqlite-backend.js";
export type { GenerateSessionTitleOptions } from "./title.js";
export type {
  SessionManagerOptions,
  SessionIndexEntry,
  CleanupResult,
  SimilarSession,
} from "./session-manager.js";
export type {
  SessionEntry,
  SessionStartEntry,
  UserEntry,
  AssistantEntry,
  ToolCallEntry,
  ToolResultEntry,
  SessionEndEntry,
  LastPromptEntry,
  CustomTitleEntry,
  AiTitleEntry,
  SummaryEntry,
  TagEntry,
  GitBranchEntry,
  PrLinkEntry,
  BranchEntry,
  BranchStatus,
  SessionSummary,
  SessionCandidate,
  ListSessionsOptions,
  ListSessionsResult,
  SessionPreviewToolUse,
  SessionPreviewMessage,
  SessionTranscriptPreview,
  LoadedSession,
  ForkSessionOptions,
  ForkedSession,
  AccumulatedCost,
  ModelCostRecord,
} from "./types.js";
