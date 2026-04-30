import stringWidth from "string-width";
import type { ChatMessage } from "../types.js";
import {
  toolUsesForDisplay,
  type RenderableToolUse,
} from "./toolProjection.js";

export const TOOL_RESULT_ESTIMATED_LINES = 6;

export interface HeightCache {
  get(key: string): number | undefined;
  set(key: string, value: number): void;
}

export function wrapLineCount(rawLine: string, wrapWidth: number): number {
  if (!rawLine) return 1;
  return Math.ceil(stringWidth(rawLine) / Math.max(1, wrapWidth)) || 1;
}

export function estimateToolUseLines(
  toolUses: RenderableToolUse[],
  expanded?: boolean,
): number {
  const displayed = toolUsesForDisplay(toolUses, expanded);
  if (!expanded) return displayed.length * TOOL_RESULT_ESTIMATED_LINES;
  return displayed.reduce((sum, toolUse) => {
    return sum + 3 + toolUse.result.content.split("\n").length;
  }, 0);
}

export function estimateMessageLines(
  msg: ChatMessage,
  wrapWidth: number,
  expandToolOutput?: boolean,
): number {
  if (msg.planMode || msg.planSteps !== undefined) {
    let lines = 2;
    for (const step of (msg.planSteps ?? [])) {
      lines += 1;
      if (step.content) {
        const n = step.content.split("\n").length;
        lines += Math.min(n, 20);
        if (n > 20) lines += 1;
      }
      lines += estimateToolUseLines(step.toolUses, expandToolOutput);
      if (step.status === "running" || (step.status === "done" && step.content)) lines += 1;
    }
    return lines;
  }

  const raw = msg.content + (msg.streaming ? "▌" : "");
  const rawLines = raw.split("\n");
  let lineCount = 0;
  for (const rawLine of rawLines) lineCount += wrapLineCount(rawLine, wrapWidth);
  lineCount += estimateToolUseLines(msg.toolUses ?? [], expandToolOutput);
  lineCount += 1;
  return lineCount;
}

export function messageHeightCacheKey(
  msg: ChatMessage,
  index: number,
  wrapWidth: number,
  expandToolOutput?: boolean,
): string {
  const toolCount = msg.toolUses?.length ?? 0;
  const planStepCount = msg.planSteps?.length ?? 0;
  return [
    index,
    msg.role,
    msg.content.length,
    msg.streaming ? "streaming" : "static",
    msg.planMode ? "plan" : "message",
    toolCount,
    planStepCount,
    wrapWidth,
    expandToolOutput ? "expanded" : "compact",
  ].join(":");
}

export function getEstimatedMessageLines(
  cache: HeightCache,
  msg: ChatMessage,
  index: number,
  wrapWidth: number,
  expandToolOutput?: boolean,
): number {
  const key = messageHeightCacheKey(msg, index, wrapWidth, expandToolOutput);
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const estimated = estimateMessageLines(msg, wrapWidth, expandToolOutput);
  cache.set(key, estimated);
  return estimated;
}
