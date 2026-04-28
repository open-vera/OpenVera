import type { LLMAdapter } from "../adapters/base.js";
import type { Message, ContentPart, Usage } from "../types/index.js";
import { estimateMessageTokens } from "./tokens.js";

// ── Types ──────────────────────────────────────────────────────────────────

export interface CompressionOptions {
  /** Enable progressive compression. Default: false */
  enabled?: boolean;
  /**
   * Trigger compression when estimated tokens exceed this threshold.
   * Default: 100_000 (half of a 200K context window).
   */
  triggerTokens?: number;
  /**
   * Keep at least this many recent turns uncompressed.
   * Default: 6
   */
  keepRecentTurns?: number;
  /**
   * Model used for compression. Should be fast and cheap.
   * Default: same as the main model.
   */
  model?: string;
}

export interface CompressedSegment {
  /** Human-readable summary of the compressed turns. */
  summary: string;
  /** Key decisions made and their rationale. */
  decisions: string[];
  /** Important facts, findings, or constraints discovered. */
  findings: string[];
  /** Items that were not yet resolved. */
  pending: string[];
  /** Which original turn range this segment covers (0-indexed). */
  turnRange: { start: number; end: number };
  /** Estimated token count of the original messages before compression. */
  originalTokenCount: number;
}

export interface CompressionState {
  segments: CompressedSegment[];
}

export function createCompressionState(): CompressionState {
  return { segments: [] };
}

// ── Micro-compact types ────────────────────────────────────────────────────

export interface MicroCompactOptions {
  /** Enable time-based tool result clearing. Default: false */
  enabled?: boolean;
  /**
   * Gap in minutes since the last assistant message after which
   * old tool results are cleared. Default: 60.
   */
  gapThresholdMinutes?: number;
  /**
   * Keep at least this many most recent tool results intact.
   * Default: 5.
   */
  keepRecent?: number;
}

/**
 * Per-message metadata for micro-compact tracking.
 * Attached as non-enumerable properties on Message objects.
 */
export interface MicroCompactState {
  /** Tool use IDs in order of appearance, for recency tracking. */
  toolUseIds: string[];
  /** Timestamp of the last assistant message (ms since epoch). */
  lastAssistantTs: number;
}

const SENTINEL_CLEARED = "[Old tool result content cleared]";

export function createMicroCompactState(): MicroCompactState {
  return { toolUseIds: [], lastAssistantTs: 0 };
}

// ── Compression prompt (aligned with Claude Code's auto-compact) ───────────

const NO_TOOLS_PREAMBLE = `CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.
- Do NOT use Read, Bash, Grep, Glob, Edit, Write, or ANY other tool.
- You already have all the context you need in the conversation above.
- Tool calls will be REJECTED and will waste your only turn.
- Your entire response must be plain text: an <analysis> block followed by a <summary> block.`;

const COMPRESSION_SYSTEM = `${NO_TOOLS_PREAMBLE}

You compress conversation history to save context space. Summarize the segment below.

## <analysis> block
A chronological scratchpad of what happened — user requests, approach taken, key decisions, files touched, errors and fixes, and specific user feedback. This block is stripped before the summary is used. Write freely.

## <summary> block
Keep all 9 sections below. Be specific — include file paths, command names, error messages, function signatures, and user quotes where relevant.

### 1. Primary Request and Intent
All user requests in detail. Capture changing intent across the conversation.

### 2. Key Technical Concepts
Technologies, frameworks, patterns discussed.

### 3. Files and Code Sections
Every file examined, modified, or created. Include what was changed and why. Include key code snippets.

### 4. Errors and Fixes
All errors encountered and how they were fixed. Pay special attention to user feedback about doing things differently.

### 5. Problem Solving
Solved problems and ongoing troubleshooting.

### 6. All User Messages
List ALL non-tool-result user messages verbatim. Critical for understanding user feedback and changing intent.

### 7. Pending Tasks
Tasks the user explicitly asked for that have not been completed.

### 8. Current Work
Precise description of what was being worked on immediately before this summary, with file names and code snippets.

### 9. Optional Next Step
Only if directly in line with the user's most recent explicit requests. Include verbatim quotes showing exactly what task was in progress and where it left off.

After the summary, the conversation will continue. The agent reading this summary will pick up where it left off — do NOT ask it to acknowledge the summary or recap.`;

// ── Turn detection ──────────────────────────────────────────────────────────

function findTurnStarts(messages: Message[]): number[] {
  return messages.reduce<number[]>((acc, msg, i) => {
    if (msg.role === "user") acc.push(i);
    return acc;
  }, []);
}

// ── Message formatting for compression input ────────────────────────────────

function formatMessage(m: Message): string {
  const role = m.role;
  if (typeof m.content === "string") return `[${role}]: ${m.content}`;

  return m.content
    .map((p) => {
      switch (p.type) {
        case "text":
          return p.text;
        case "tool_call":
          return `[CALL ${p.name}(${p.arguments.slice(0, 200)})]`;
        case "tool_result":
          return `[RESULT ${p.content.slice(0, 800)}${p.content.length > 800 ? "..." : ""}]`;
        default:
          return "";
      }
    })
    .join("\n");
}

function formatTurn(
  messages: Message[],
  start: number,
  end: number,
): string {
  return messages
    .slice(start, end)
    .map(formatMessage)
    .join("\n");
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function extractText(message: Message): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .filter((p): p is ContentPart & { type: "text" } => p.type === "text")
    .map((p) => p.text)
    .join("");
}

/**
 * Strip the <analysis> block, keep only <summary>.
 * Matches Claude Code's formatCompactSummary behavior.
 */
function stripAnalysis(text: string): string {
  const summaryTag = text.indexOf("<summary>");
  if (summaryTag !== -1) return text.slice(summaryTag);
  // No tags found — return as-is (model may have omitted them)
  return text;
}

interface CompressionOutput {
  summary: string;
  decisions: string[];
  findings: string[];
  pending: string[];
}

function parseCompressionOutput(text: string): CompressionOutput {
  // Strip <analysis> block first
  const summaryText = stripAnalysis(text);

  // Try JSON fence
  const fence = summaryText.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fence ? fence[1]!.trim() : summaryText;

  const fallback = (): CompressionOutput => ({
    summary: summaryText.slice(0, 800),
    decisions: [],
    findings: [],
    pending: [],
  });

  try {
    const match = candidate.match(/\{[\s\S]*\}/);
    if (!match) return fallback();
    const obj = JSON.parse(match[0]) as Record<string, unknown>;
    return {
      summary: String(obj.summary ?? ""),
      decisions: Array.isArray(obj.decisions)
        ? obj.decisions.map(String)
        : [],
      findings: Array.isArray(obj.findings)
        ? obj.findings.map(String)
        : [],
      pending: Array.isArray(obj.pending)
        ? obj.pending.map(String)
        : [],
    };
  } catch {
    return fallback();
  }
}

function buildSyntheticMessage(
  turnLabel: string,
  output: CompressionOutput,
  isReactive: boolean,
): Message {
  const preamble = isReactive
    ? "[Context compressed after prompt overflow — conversation continues below]"
    : `[Compressed context — ${turnLabel}]`;

  const parts: string[] = [preamble, output.summary];

  if (output.decisions.length > 0) {
    parts.push(
      `\nDecisions:\n${output.decisions.map((d) => `- ${d}`).join("\n")}`,
    );
  }
  if (output.findings.length > 0) {
    parts.push(
      `\nFindings:\n${output.findings.map((f) => `- ${f}`).join("\n")}`,
    );
  }
  if (output.pending.length > 0) {
    parts.push(
      `\nPending:\n${output.pending.map((p) => `- ${p}`).join("\n")}`,
    );
  }

  // Continue-silently instruction (aligned with Claude Code)
  parts.push(
    "\nContinue the conversation from where it left off without asking the user any questions. " +
    "Do not acknowledge the summary, do not recap what was happening, " +
    "do not preface with anything. Pick up the last task as if the break never happened.",
  );

  return { role: "user", content: parts.join("\n") };
}

// ── Core compression ────────────────────────────────────────────────────────

/**
 * Compress old conversation turns into a structured summary.
 *
 * Called before each API request when {@link CompressionOptions.enabled} is true.
 * When the estimated token count exceeds `triggerTokens`, the oldest turns
 * (keeping at least `keepRecentTurns` recent turns intact) are sent to an LLM
 * for summarization. The compressed output replaces those turns as a synthetic
 * message, preserving key decisions, findings, and pending items.
 *
 * On re-compression (when the context grows again), the previous synthetic
 * message is included in the text sent for compression, so the result is a
 * single updated summary that subsumes all prior history.
 *
 * When `isReactive` is true (called from reactive compact), the threshold is
 * ignored — compression always runs and the synthetic message uses a different
 * preamble.
 *
 * Returns the (possibly compressed) messages and updated state.
 */
export async function compressMessages(
  messages: Message[],
  state: CompressionState,
  options: CompressionOptions,
  adapter: LLMAdapter,
  model: string,
  isReactive = false,
): Promise<{ messages: Message[]; state: CompressionState; usage?: Usage }> {
  const {
    enabled = false,
    triggerTokens = 100_000,
    keepRecentTurns = 6,
  } = options;

  if (!enabled && !isReactive) return { messages, state, usage: undefined };

  const currentTokens = estimateMessageTokens(messages);
  if (!isReactive && currentTokens <= triggerTokens) return { messages, state, usage: undefined };

  const turnStarts = findTurnStarts(messages);
  const totalTurns = turnStarts.length;

  // In reactive mode, keep fewer turns (more aggressive compression)
  const effectiveKeep = isReactive
    ? Math.max(2, Math.floor(keepRecentTurns / 2))
    : keepRecentTurns;

  if (totalTurns <= effectiveKeep + 1) return { messages, state, usage: undefined };

  const turnsToCompress = totalTurns - effectiveKeep;
  if (turnsToCompress <= 0) return { messages, state, usage: undefined };

  const compressEndIdx = turnStarts[turnsToCompress]!;
  const oldMessages = messages.slice(0, compressEndIdx);
  const recentMessages = messages.slice(compressEndIdx);

  // Format old turns as text for the compression LLM
  const formattedTurns: string[] = [];
  for (let i = 0; i < turnsToCompress; i++) {
    const start = turnStarts[i]!;
    const end =
      i + 1 < turnStarts.length ? turnStarts[i + 1]! : messages.length;
    formattedTurns.push(
      `--- Turn ${i + 1} ---\n${formatTurn(messages, start, end)}`,
    );
  }

  const segmentText = formattedTurns.join("\n\n");

  // Call compression LLM (with error fallback)
  let output: CompressionOutput;
  let compressionUsage: Usage | undefined;
  try {
    const compressModel = options.model ?? model;
    const response = await adapter.complete({
      model: compressModel,
      max_tokens: 2048,
      temperature: 0,
      system: COMPRESSION_SYSTEM,
      messages: [{ role: "user", content: segmentText }],
    });
    output = parseCompressionOutput(extractText(response.message));
    compressionUsage = response.usage;
  } catch {
    // Compression failed — skip this round, will retry next turn
    return { messages, state, usage: undefined };
  }

  if (!output.summary) return { messages, state, usage: undefined };

  const segment: CompressedSegment = {
    summary: output.summary,
    decisions: output.decisions,
    findings: output.findings,
    pending: output.pending,
    turnRange: { start: 0, end: turnsToCompress - 1 },
    originalTokenCount: estimateMessageTokens(oldMessages),
  };

  const turnLabel =
    turnsToCompress === 1 ? "turn 1" : `turns 1–${turnsToCompress}`;
  const synthetic = buildSyntheticMessage(turnLabel, output, isReactive);

  return {
    messages: [synthetic, ...recentMessages],
    state: { segments: [...state.segments, segment] },
    usage: compressionUsage,
  };
}

// ── Micro-compact (time-based tool result clearing) ─────────────────────────

/**
 * Clear old tool results when the gap since the last assistant message
 * exceeds the threshold. Pure heuristic — no LLM call.
 *
 * Aligned with Claude Code's time-based micro-compact path
 * (microCompact.ts:446-530).
 *
 * Returns mutated messages and updated state.
 * When nothing to clear, returns the same array reference.
 */
export function microCompact(
  messages: Message[],
  state: MicroCompactState,
  options: MicroCompactOptions,
): { messages: Message[]; state: MicroCompactState } {
  const {
    enabled = false,
    gapThresholdMinutes = 60,
    keepRecent = 5,
  } = options;

  if (!enabled) return { messages, state };

  // Check gap using the *previous* timestamp before updating from messages
  const gapMs = Date.now() - state.lastAssistantTs;
  const thresholdMs = gapThresholdMinutes * 60 * 1000;
  const shouldClear = state.lastAssistantTs !== 0 && gapMs >= thresholdMs;

  // Update state from current messages for the next call
  const newState: MicroCompactState = {
    toolUseIds: [...state.toolUseIds],
    lastAssistantTs: state.lastAssistantTs,
  };

  // Only track tool IDs here. lastAssistantTs is updated by the agent loop
  // immediately after each real assistant response — scanning historical messages
  // and calling Date.now() would reset the gap to zero every turn, defeating
  // the time-based clearing logic.
  for (const m of messages) {
    if (m.role === "tool" && m.tool_call_id) {
      if (!newState.toolUseIds.includes(m.tool_call_id)) {
        newState.toolUseIds.push(m.tool_call_id);
      }
    }
  }

  if (!shouldClear) {
    return { messages, state: newState };
  }

  // Clear old tool results, keeping the most recent ones
  // slice(0, -0) would return [] in JS, so handle keepRecent=0 explicitly
  const idsToClear = new Set(
    keepRecent > 0
      ? newState.toolUseIds.slice(0, -keepRecent)
      : newState.toolUseIds,
  );

  if (idsToClear.size === 0) {
    return { messages, state: newState };
  }

  const cleared = messages.map((m) => {
    if (
      m.role === "tool" &&
      m.tool_call_id &&
      idsToClear.has(m.tool_call_id) &&
      typeof m.content === "string" &&
      m.content !== SENTINEL_CLEARED
    ) {
      return { ...m, content: SENTINEL_CLEARED };
    }
    return m;
  });

  return { messages: cleared, state: newState };
}

// ── Reactive compact helper ─────────────────────────────────────────────────

/** Error message patterns that indicate context overflow. */
const PROMPT_TOO_LONG_PATTERNS = [
  /prompt is too long/i,
  /prompt_too_long/i,
  /tokens?.*>\s*\d+/i,
  /context length exceeds/i,
  /input.*too.*(?:long|large)/i,
];

/**
 * Check whether an error signals a context overflow that reactive compact
 * can recover from.
 */
export function isPromptTooLongError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return PROMPT_TOO_LONG_PATTERNS.some((p) => p.test(error.message));
}

// ── Recall ──────────────────────────────────────────────────────────────────

/**
 * Search compressed segments for those matching a query.
 * Simple substring match across summary, decisions, and findings.
 * Returns segments sorted by relevance (most fields matched first).
 */
export function findRelevantSegments(
  state: CompressionState,
  query: string,
): CompressedSegment[] {
  const q = query.toLowerCase();
  const scored = state.segments.map((seg) => {
    const haystack = [
      seg.summary,
      ...seg.decisions,
      ...seg.findings,
    ].join(" ");
    const count = (haystack.match(new RegExp(q, "gi")) ?? []).length;
    return { seg, count };
  });

  return scored
    .filter((s) => s.count > 0)
    .sort((a, b) => b.count - a.count)
    .map((s) => s.seg);
}

/**
 * Expand a compressed segment back to original messages.
 * Requires the original messages to still be available.
 * Returns null if the segment index is out of bounds.
 */
export function expandSegment(
  state: CompressionState,
  segmentIndex: number,
  originalMessages: Message[],
): Message[] | null {
  const segment = state.segments[segmentIndex];
  if (!segment) return null;
  return originalMessages.slice(
    segment.turnRange.start,
    segment.turnRange.end + 1,
  );
}
