import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Message } from "../types/index.js";

// ── Constants ─────────────────────────────────────────────────────────────────

/** Default per-result threshold. Results larger than this are persisted to disk. */
export const DEFAULT_MAX_RESULT_SIZE_CHARS = 50_000;

/** Per-turn aggregate budget. If all fresh tool results in one turn together
 *  exceed this, the largest ones are offloaded until under budget. */
export const MAX_PER_TURN_CHARS = 200_000;

/** How many chars of a large result to include as an inline preview. */
export const PREVIEW_SIZE_CHARS = 2_000;

const OVERFLOW_OPEN = "<tool-result-overflow>";
const OVERFLOW_CLOSE = "</tool-result-overflow>";

// ── State ─────────────────────────────────────────────────────────────────────

/**
 * Tracks budget decisions across turns so they are never re-evaluated.
 * This keeps prompt-cache prefixes byte-identical.
 *
 *  seenIds       – every toolUseId that has been evaluated (replaced or not).
 *                  IDs present here but absent from `replacements` are frozen
 *                  in their original form and will never be replaced later.
 *  replacements  – toolUseId → overflow message. Re-applied verbatim each turn.
 */
export interface ToolResultBudgetState {
  seenIds: Set<string>;
  replacements: Map<string, string>;
}

export function createToolBudgetState(): ToolResultBudgetState {
  return { seenIds: new Set(), replacements: new Map() };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildOverflowMessage(
  filepath: string,
  originalSize: number,
  preview: string,
  hasMore: boolean
): string {
  return [
    OVERFLOW_OPEN,
    `Output too large (${originalSize} chars). Full output saved to: ${filepath}`,
    "",
    `Preview (first ${PREVIEW_SIZE_CHARS} chars):`,
    preview,
    ...(hasMore ? ["..."] : []),
    OVERFLOW_CLOSE,
  ].join("\n");
}

async function persistContent(
  content: string,
  toolUseId: string,
  runDir: string
): Promise<string> {
  const dir = join(runDir, "tool-results");
  await mkdir(dir, { recursive: true });
  const filepath = join(dir, `${toolUseId}.txt`);
  try {
    // "wx" = exclusive create — skip if already written in a prior turn
    await writeFile(filepath, content, { encoding: "utf-8", flag: "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
  return filepath;
}

async function offload(
  toolUseId: string,
  content: string,
  runDir: string
): Promise<string> {
  const filepath = await persistContent(content, toolUseId, runDir);
  const preview = content.slice(0, PREVIEW_SIZE_CHARS);
  const hasMore = content.length > PREVIEW_SIZE_CHARS;
  return buildOverflowMessage(filepath, content.length, preview, hasMore);
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Process a single tool result at write time.
 *
 * If the output exceeds `maxResultSizeChars`, it is persisted to disk and an
 * overflow message (preview + filepath) is returned instead. The decision is
 * recorded in `state` so that subsequent turns replay the same replacement
 * byte-for-byte (prompt-cache stability).
 *
 * When `runDir` is not provided the result is returned unchanged regardless
 * of size (budget enforcement disabled).
 */
export async function processToolResult(
  toolUseId: string,
  output: string,
  state: ToolResultBudgetState,
  runDir: string | undefined,
  maxResultSizeChars = DEFAULT_MAX_RESULT_SIZE_CHARS
): Promise<string> {
  // Re-apply frozen replacement (byte-identical replay)
  const cached = state.replacements.get(toolUseId);
  if (cached !== undefined) return cached;

  // Already seen but not replaced → frozen in original form
  if (state.seenIds.has(toolUseId)) return output;

  state.seenIds.add(toolUseId);

  if (!runDir || output.length <= maxResultSizeChars) return output;

  const msg = await offload(toolUseId, output, runDir);
  state.replacements.set(toolUseId, msg);
  return msg;
}

/**
 * Re-apply all known replacements to a messages array.
 *
 * Call this before every `adapter.complete()` so that previously-replaced
 * results appear byte-identical in every API request (prompt cache hits).
 * Returns the same array reference when there is nothing to replace.
 */
export function reapplyReplacements(
  messages: Message[],
  state: ToolResultBudgetState
): Message[] {
  if (state.replacements.size === 0) return messages;
  let mutated = false;
  const next = messages.map((m) => {
    if (m.role !== "tool") return m;
    const id = m.tool_call_id ?? "";
    const replacement = state.replacements.get(id);
    if (replacement === undefined) return m;
    mutated = true;
    return { ...m, content: replacement };
  });
  return mutated ? next : messages;
}

/**
 * Enforce the per-turn aggregate budget before an API call.
 *
 * Groups the fresh (not yet in `state.seenIds`) tool messages that follow the
 * last assistant message. If their combined size exceeds MAX_PER_TURN_CHARS,
 * the largest ones are offloaded greedily until the aggregate is under budget.
 *
 * Has no effect when `runDir` is not provided.
 */
export async function enforcePerTurnBudget(
  messages: Message[],
  state: ToolResultBudgetState,
  runDir: string | undefined
): Promise<Message[]> {
  if (!runDir) return messages;

  // Find the last assistant turn boundary
  const lastAsstIdx = messages.reduceRight(
    (found, m, i) => (found === -1 && m.role === "assistant" ? i : found),
    -1
  );

  // Collect fresh tool results after the last assistant message
  const fresh: Array<{ idx: number; id: string; size: number }> = [];
  let frozenSize = 0;

  for (let i = lastAsstIdx + 1; i < messages.length; i++) {
    const m = messages[i]!;
    if (m.role !== "tool") continue;
    const id = m.tool_call_id ?? "";
    const content = typeof m.content === "string" ? m.content : "";

    if (state.seenIds.has(id)) {
      frozenSize += content.length;
    } else {
      fresh.push({ idx: i, id, size: content.length });
    }
  }

  const freshTotal = fresh.reduce((s, r) => s + r.size, 0);
  if (frozenSize + freshTotal <= MAX_PER_TURN_CHARS) return messages;

  // Greedy: offload the largest fresh results first
  const sorted = [...fresh].sort((a, b) => b.size - a.size);
  const toOffload = new Set<string>();
  let remaining = frozenSize + freshTotal;

  for (const r of sorted) {
    if (remaining <= MAX_PER_TURN_CHARS) break;
    toOffload.add(r.id);
    remaining -= r.size;
  }

  if (toOffload.size === 0) return messages;

  // Build overflow messages for selected results
  const overflowMap = new Map<string, string>();
  for (const r of fresh) {
    if (!toOffload.has(r.id)) continue;
    const content =
      typeof messages[r.idx]!.content === "string"
        ? (messages[r.idx]!.content as string)
        : "";
    const msg = await offload(r.id, content, runDir);
    overflowMap.set(r.id, msg);
    state.seenIds.add(r.id);
    state.replacements.set(r.id, msg);
  }

  return messages.map((m) => {
    if (m.role !== "tool") return m;
    const id = m.tool_call_id ?? "";
    const overflow = overflowMap.get(id);
    return overflow !== undefined ? { ...m, content: overflow } : m;
  });
}
