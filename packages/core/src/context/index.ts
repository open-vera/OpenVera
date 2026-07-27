export {
  estimateTokens,
  estimateMessageTokens,
  BYTES_PER_TOKEN,
} from "./tokens.js";

export {
  estimateContextUsedFromUsage,
  latestContextBreakdown,
} from "./occupancy.js";
export type { ContextOccupancyBreakdown } from "./occupancy.js";

export {
  trimToWindow,
  getModelContextLimit,
  MODEL_CONTEXT_LIMITS,
} from "./window.js";
export type { ContextWindowOptions } from "./window.js";

export {
  createToolBudgetState,
  processToolResult,
  reapplyReplacements,
  enforcePerTurnBudget,
  DEFAULT_MAX_RESULT_SIZE_CHARS,
  MAX_PER_TURN_CHARS,
  PREVIEW_SIZE_CHARS,
} from "./tool-budget.js";
export type { ToolResultBudgetState } from "./tool-budget.js";

export {
  compressMessages,
  createCompressionState,
  resolveContextOccupancy,
  microCompact,
  createMicroCompactState,
  isPromptTooLongError,
  findRelevantSegments,
  expandSegment,
  buildCompressionInstruction,
  parseCompressionResponse,
  buildSyntheticFromOutput,
  insertCompressionInstruction,
  resolveInsertCompress,
} from "./compression.js";
export type {
  CompressionOptions,
  CompressedSegment,
  CompressionState,
  MicroCompactOptions,
  MicroCompactState,
  InsertCompressPending,
} from "./compression.js";

export { IdleCompressionTimer } from "./idle-compression.js";
export type {
  IdleCompressionOptions,
  IdleCompressionResult,
  IdleCompressionStatus,
} from "./idle-compression.js";
