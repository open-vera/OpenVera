import type { FileChange, Message, ToolCall, ToolResult } from "@/types";
import { formatChatTime, shouldShowChatTime } from "@/utils/chat-time";
import { isVisibleToolProgressStep, summarizeToolCall } from "@/utils/tool-progress";
import { aggregateTurnFileChanges } from "@/utils/turn-file-changes";

export type ChatDisplayItem =
  | { type: "time"; key: string; label: string }
  | { type: "message"; key: string; turnId?: string; message: Message }
  | {
      type: "tool-progress";
      key: string;
      turnId?: string;
      messageIds: string[];
      timestamp: number;
      endedAt?: number;
      toolCalls: ToolCall[];
      toolResults: ToolResult[];
    }
  | { type: "turn-changes"; key: string; turnId?: string; changes: FileChange[] };

/**
 * A turn is one agent run. Its process items (narration between tool batches +
 * tool blocks) collapse behind a single header; the final answer and the file
 * changes stay outside so the result is always readable.
 */
export interface ChatTurnEntry {
  type: "turn";
  key: string;
  turnId: string;
  /** Narration + tool blocks, in event order. */
  processItems: ChatDisplayItem[];
  /** Last assistant message of the turn — rendered outside the collapse. */
  finalMessage: Message | null;
  changes: ChatDisplayItem | null;
  startedAt: number;
  endedAt: number | null;
  /** True while the turn has a streaming message (no end stamp yet). */
  isOpen: boolean;
}

export type ChatTimelineEntry =
  | { type: "item"; key: string; item: ChatDisplayItem }
  | ChatTurnEntry;

export function hasVisibleToolProgress(
  toolCalls: ToolCall[],
  locale: "zh-CN" | "en-US",
): boolean {
  return toolCalls
    .map((toolCall) => summarizeToolCall(toolCall, locale))
    .some(isVisibleToolProgressStep);
}

/**
 * Flatten messages into renderable items. Consecutive `tool` messages merge into
 * one block; a text segment in between breaks the block, which is how the
 * transcript keeps the real "narrate → act → narrate" order.
 */
export function buildChatDisplayItems(messages: Message[]): ChatDisplayItem[] {
  const items: ChatDisplayItem[] = [];
  let activeToolGroup: Extract<ChatDisplayItem, { type: "tool-progress" }> | null = null;
  let pendingToolResults: ToolResult[] | null = null;
  let pendingToolGroupKey: string | null = null;
  let pendingTurnId: string | undefined;
  let lastVisibleTimestamp: number | null = null;

  const appendTimeIfNeeded = (timestamp: number) => {
    if (!shouldShowChatTime(lastVisibleTimestamp, timestamp)) return;
    items.push({
      type: "time",
      key: `time:${timestamp}`,
      label: formatChatTime(timestamp),
    });
  };

  const pushTurnChanges = (key: string, toolResults: ToolResult[] | null, turnId?: string) => {
    const changes = aggregateTurnFileChanges(toolResults ?? undefined);
    if (!changes.length) return;
    items.push({ type: "turn-changes", key, turnId, changes });
  };

  for (const message of messages) {
    if (message.role === "assistant" && message.isStreaming && !message.content.trim()) {
      continue;
    }

    if (message.role === "tool" && message.toolCalls?.length) {
      if (!activeToolGroup) {
        appendTimeIfNeeded(message.timestamp);
        activeToolGroup = {
          type: "tool-progress",
          key: `tools:${message.id}`,
          turnId: message.turnId,
          messageIds: [],
          timestamp: message.timestamp,
          endedAt: message.endedAt,
          toolCalls: [],
          toolResults: [],
        };
        items.push(activeToolGroup);
        pendingToolResults = activeToolGroup.toolResults;
        pendingToolGroupKey = activeToolGroup.key;
        pendingTurnId = message.turnId;
      }
      activeToolGroup.messageIds.push(message.id);
      activeToolGroup.toolCalls.push(...message.toolCalls);
      activeToolGroup.toolResults.push(...(message.toolResults ?? []));
      if (message.endedAt) activeToolGroup.endedAt = message.endedAt;
      lastVisibleTimestamp = message.timestamp;
      continue;
    }

    const toolResultsForTurn = pendingToolResults;
    const toolGroupKey = pendingToolGroupKey;
    const toolTurnId = pendingTurnId;
    activeToolGroup = null;

    if (message.role !== "assistant" && toolResultsForTurn && toolGroupKey) {
      pushTurnChanges(`changes:${toolGroupKey}`, toolResultsForTurn, toolTurnId);
      pendingToolResults = null;
      pendingToolGroupKey = null;
    }

    appendTimeIfNeeded(message.timestamp);
    items.push({
      type: "message",
      key: message.id,
      turnId: message.turnId,
      message,
    });
    lastVisibleTimestamp = message.timestamp;

    // Within a turn the changes panel belongs to the whole run, so hold it back
    // until the turn ends instead of emitting one per narration segment.
    if (
      message.role === "assistant" &&
      !message.turnId &&
      toolResultsForTurn &&
      toolGroupKey
    ) {
      pushTurnChanges(`changes:${toolGroupKey}`, toolResultsForTurn, toolTurnId);
      pendingToolResults = null;
      pendingToolGroupKey = null;
    }
  }

  if (pendingToolResults && pendingToolGroupKey) {
    pushTurnChanges(`changes:${pendingToolGroupKey}`, pendingToolResults, pendingTurnId);
  }

  return items;
}

/** Move a turn's last narration out of the process list — that's the answer. */
function extractFinalMessage(turn: ChatTurnEntry): void {
  for (let index = turn.processItems.length - 1; index >= 0; index -= 1) {
    const candidate = turn.processItems[index];
    if (candidate && candidate.type === "message" && candidate.message.role === "assistant") {
      turn.finalMessage = candidate.message;
      turn.processItems.splice(index, 1);
      return;
    }
  }
}

/**
 * Group items by `turnId`. Items without one (user messages, time separators,
 * legacy sessions recorded before segmentation) stay standalone.
 */
export function buildChatTimelineEntries(items: ChatDisplayItem[]): ChatTimelineEntry[] {
  const entries: ChatTimelineEntry[] = [];
  const turns = new Map<string, ChatTurnEntry>();
  let openTurn: ChatTurnEntry | null = null;

  for (const item of items) {
    const turnId = item.type === "time" ? undefined : item.turnId;
    if (!turnId) {
      if (openTurn) extractFinalMessage(openTurn);
      openTurn = null;
      entries.push({ type: "item", key: item.key, item });
      continue;
    }

    let turn = turns.get(turnId);
    if (!turn) {
      if (openTurn) extractFinalMessage(openTurn);
      turn = {
        type: "turn",
        key: `turn:${turnId}`,
        turnId,
        processItems: [],
        finalMessage: null,
        changes: null,
        startedAt: itemTimestamp(item) ?? 0,
        endedAt: null,
        isOpen: false,
      };
      turns.set(turnId, turn);
      entries.push(turn);
    }
    openTurn = turn;

    if (item.type === "turn-changes") {
      turn.changes = item;
      continue;
    }
    turn.processItems.push(item);
    const ended = itemEndedAt(item);
    if (ended) turn.endedAt = Math.max(turn.endedAt ?? 0, ended);
    if (item.type === "message" && item.message.isStreaming) turn.isOpen = true;
  }

  if (openTurn) extractFinalMessage(openTurn);
  return entries;
}

function itemTimestamp(item: ChatDisplayItem): number | null {
  if (item.type === "tool-progress") return item.timestamp;
  if (item.type === "message") return item.message.timestamp;
  return null;
}

function itemEndedAt(item: ChatDisplayItem): number | null {
  if (item.type === "tool-progress") return item.endedAt ?? null;
  if (item.type === "message") return item.message.endedAt ?? null;
  return null;
}

/** Wall-clock span of a turn; null until an end stamp exists. */
export function turnDurationMs(turn: ChatTurnEntry): number | null {
  const end = turn.endedAt ?? turn.finalMessage?.endedAt ?? null;
  if (!end || !turn.startedAt) return null;
  return Math.max(0, end - turn.startedAt);
}
