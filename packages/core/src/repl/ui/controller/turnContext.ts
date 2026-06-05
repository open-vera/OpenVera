import { readFileSync } from "node:fs";
import type { SessionConfig } from "../../../config/types.js";
import type { MemoryFile } from "../../../memory/index.js";

export const MEMORY_FILE_CHAR_LIMIT = 8_000;
export const MEMORY_TOTAL_CHAR_LIMIT = 24_000;
export const MEMORY_REFRESH_TURNS = 5;
export const CONTEXT_TARGET_UTILIZATION = 0.85;
export const COMPRESSION_TRIGGER_UTILIZATION = 0.78;

export function memoryInventorySignature(memories: MemoryFile[]): string {
  return memories
    .map((m) => `${m.path}:${Math.floor(m.mtimeMs)}`)
    .sort()
    .join("|");
}

export function shouldRefreshMemoryInventory(options: {
  selectedCount: number;
  currentTurn: number;
  frozenTurn: number;
  currentSignature: string;
  frozenSignature: string;
  refreshTurns?: number;
}): boolean {
  const refreshTurns = options.refreshTurns ?? MEMORY_REFRESH_TURNS;
  return options.selectedCount === 0 ||
    options.currentTurn - options.frozenTurn >= refreshTurns ||
    options.currentSignature !== options.frozenSignature;
}

export function buildMemoryPreamble(memories: MemoryFile[]): string {
  if (memories.length === 0) return "";
  const blocks: string[] = [];
  let remaining = MEMORY_TOTAL_CHAR_LIMIT;
  for (const memory of memories) {
    if (remaining <= 0) break;
    try {
      const raw = readFileSync(memory.path, "utf8");
      const body = raw.slice(0, Math.min(MEMORY_FILE_CHAR_LIMIT, remaining));
      const truncated = raw.length > body.length ? "\n[truncated]" : "";
      blocks.push(
        [`### ${memory.filename}`, memory.description ? `description: ${memory.description}` : "", memory.type ? `type: ${memory.type}` : "", body + truncated]
          .filter(Boolean).join("\n"),
      );
      remaining -= body.length;
    } catch {
      // Memory files are opportunistic context; ignore files that disappeared.
    }
  }
  if (blocks.length === 0) return "";
  return ["", "Relevant memory files selected for this turn:", blocks.join("\n\n")].join("\n");
}

export function buildDynamicContextOptions(
  modelContextLimit: number,
  model: string,
  compactConfig?: SessionConfig["compact"],
) {
  return {
    contextOptions: {
      maxTokens: modelContextLimit,
      targetUtilization: CONTEXT_TARGET_UTILIZATION,
      keepRecentTurns: 6,
    },
    compressionOptions: {
      enabled: compactConfig?.enabled !== false,
      triggerTokens: Math.floor(modelContextLimit * COMPRESSION_TRIGGER_UTILIZATION),
      keepRecentTurns: 6,
      model: compactConfig?.model ?? model,
    },
    ...(compactConfig?.provider ? { compressionProvider: compactConfig.provider } : {}),
    microCompactOptions: {
      enabled: true,
      gapThresholdMinutes: 60,
      keepRecent: 5,
    },
  };
}
