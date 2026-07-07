import { formatChatTime } from "@/utils/chat-time";

export type RunningDisplayItem =
  | { type: "time"; key: string; label: string }
  | { type: "thinking"; key: string; label: string }
  | { type: "message"; key: string; message: { timestamp: number } }
  | {
      type: "tool-progress";
      key: string;
      timestamp: number;
      toolCalls: unknown[];
      toolResults: unknown[];
    };

function itemTimestamp(item: RunningDisplayItem | undefined): number | null {
  if (!item) return null;
  if (item.type === "message") return item.message.timestamp;
  if (item.type === "tool-progress") return item.timestamp;
  return null;
}

export function collapseRunningDisplayItems(
  runningItems: RunningDisplayItem[],
  maxNonTimeItems = 5,
): RunningDisplayItem[] {
  const nonTimeItems = runningItems.filter((item) => item.type !== "time");
  if (nonTimeItems.length === 0) {
    return [{ type: "thinking", key: "running-thinking", label: "思考中..." }];
  }

  const visibleIndexes = runningItems
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item.type !== "time")
    .slice(-maxNonTimeItems)
    .map(({ index }) => index);

  const firstVisibleIndex = visibleIndexes[0] ?? 0;
  if (firstVisibleIndex <= 0) return runningItems;

  let startIndex = firstVisibleIndex;
  const collapsed: RunningDisplayItem[] = [];

  if (runningItems[startIndex - 1]?.type === "time") {
    startIndex -= 1;
  } else {
    const timestamp = itemTimestamp(runningItems[startIndex]);
    if (timestamp !== null) {
      collapsed.push({
        type: "time",
        key: `time:running:${timestamp}`,
        label: formatChatTime(timestamp),
      });
    }
  }

  collapsed.push(...runningItems.slice(startIndex));
  return collapsed;
}
