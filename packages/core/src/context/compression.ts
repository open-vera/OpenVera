import type { LLMAdapter } from "../adapters/base.js";
import type { Message, ContentPart } from "../types/index.js";
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

// ── Compression prompt ──────────────────────────────────────────────────────

const COMPRESSION_SYSTEM = `You compress conversation history to save context space. Summarize the segment below.

Your output must preserve these for the agent to continue working:
1. **Goal**: What the user originally asked for
2. **Decisions**: Key decisions made and their rationale
3. **Actions**: What was done — files, commands, tools — with outcomes
4. **Findings**: Important facts, errors, constraints discovered
5. **Pending**: What still needs to be done or was left unresolved

Return ONLY a JSON object, no other text:
{
  "summary": "concise paragraph summarizing what happened and what was accomplished",
  "decisions": ["decision 1", "decision 2"],
  "findings": ["finding 1"],
  "pending": ["pending item 1"]
}

Be specific. Include file paths, command names, error messages where relevant. Omit empty arrays.`;

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
  end: number
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

interface CompressionOutput {
  summary: string;
  decisions: string[];
  findings: string[];
  pending: string[];
}

function parseCompressionOutput(text: string): CompressionOutput {
  // Try JSON fence first
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fence ? fence[1]!.trim() : text;

  const fallback = (): CompressionOutput => ({
    summary: text.slice(0, 500),
    decisions: [],
    findings: [],
    pending: [],
  });

  try {
    // Find the outermost JSON object
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
  output: CompressionOutput
): Message {
  const parts: string[] = [
    `[Compressed context — ${turnLabel}]`,
    output.summary,
  ];

  if (output.decisions.length > 0) {
    parts.push(
      `\nDecisions:\n${output.decisions.map((d) => `- ${d}`).join("\n")}`
    );
  }
  if (output.findings.length > 0) {
    parts.push(
      `\nFindings:\n${output.findings.map((f) => `- ${f}`).join("\n")}`
    );
  }
  if (output.pending.length > 0) {
    parts.push(
      `\nPending:\n${output.pending.map((p) => `- ${p}`).join("\n")}`
    );
  }

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
 * Returns the (possibly compressed) messages and updated state.
 */
export async function compressMessages(
  messages: Message[],
  state: CompressionState,
  options: CompressionOptions,
  adapter: LLMAdapter,
  model: string,
): Promise<{ messages: Message[]; state: CompressionState }> {
  const {
    enabled = false,
    triggerTokens = 100_000,
    keepRecentTurns = 6,
  } = options;

  if (!enabled) return { messages, state };

  const currentTokens = estimateMessageTokens(messages);
  if (currentTokens <= triggerTokens) return { messages, state };

  const turnStarts = findTurnStarts(messages);
  const totalTurns = turnStarts.length;

  // Need at least keepRecentTurns + 2 turns to compress (2 turns minimum to compress)
  if (totalTurns <= keepRecentTurns + 1) return { messages, state };

  const turnsToCompress = totalTurns - keepRecentTurns;
  if (turnsToCompress <= 0) return { messages, state };

  // `compressEndIdx` is the first index of the recent turns we keep
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
      `--- Turn ${i + 1} ---\n${formatTurn(messages, start, end)}`
    );
  }

  const segmentText = formattedTurns.join("\n\n");

  // Call compression LLM (with error fallback)
  let output: CompressionOutput;
  try {
    const compressModel = options.model ?? model;
    const response = await adapter.complete({
      model: compressModel,
      max_tokens: 1024,
      temperature: 0,
      system: COMPRESSION_SYSTEM,
      messages: [{ role: "user", content: segmentText }],
    });
    output = parseCompressionOutput(extractText(response.message));
  } catch {
    // Compression failed — skip this round, will retry next turn
    return { messages, state };
  }

  if (!output.summary) return { messages, state };

  // Build the compressed segment
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
  const synthetic = buildSyntheticMessage(turnLabel, output);

  return {
    messages: [synthetic, ...recentMessages],
    state: {
      segments: [...state.segments, segment],
    },
  };
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
