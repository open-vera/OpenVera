import { useEffect, useRef } from "react";
import { Box, Text } from "ink";
import type { ChatMessage, PlanStepUI } from "./types.js";
import { ToolResultView } from "./ToolResultView.js";
import { theme } from "./theme.js";

const TOOL_RESULT_ESTIMATED_LINES = 6;

type RenderableToolUse = {
  name: string;
  args: Record<string, unknown>;
  result: {
    ok: boolean;
    content: string;
  };
};

interface ConversationPanelProps {
  messages: ChatMessage[];
  width: number;
  availableHeight: number;
  scrollOffset: number; // lines scrolled up from bottom (0 = follow bottom)
  expandToolOutput?: boolean;
  onScrollAdjust?: (delta: number) => void; // called when content grows while user is scrolled up
}

// ── Plan step renderer ────────────────────────────────────────────────────────

const STEP_ICONS = {
  pending: "○",
  running: "▶",
  done:    "✓",
  failed:  "✗",
} as const;

const STEP_COLORS = {
  pending: theme.stepPending,
  running: theme.stepRunning,
  done:    theme.stepDone,
  failed:  theme.stepFailed,
} as const;

function PlanStepRow({
  step,
  isActive,
  width,
  expandToolOutput,
}: {
  step: PlanStepUI;
  isActive: boolean;
  width: number;
  expandToolOutput?: boolean;
}) {
  const icon = STEP_ICONS[step.status];
  const color = STEP_COLORS[step.status];

  return (
    <Box flexDirection="column" marginBottom={step.status === "running" || (step.status === "done" && step.content) ? 1 : 0}>
      {/* Step header */}
      <Box>
        <Text color={color} bold={isActive}>{icon} </Text>
        <Text color={isActive ? theme.text : theme.textDim} bold={isActive}>{step.description}</Text>
        {step.status === "running" && <Text color={theme.stepRunning}> ▌</Text>}
      </Box>

      {/* Tool uses */}
      {step.toolUses.length > 0 && (
        <Box flexDirection="column" paddingLeft={2}>
          {toolUsesForDisplay(step.toolUses, expandToolOutput).map((tu, i) => (
            <ToolResultView
              key={i}
              toolName={tu.name}
              args={tu.args}
              result={tu.result}
              width={width - 2}
              preface={getToolPreface(tu)}
              expanded={expandToolOutput}
            />
          ))}
        </Box>
      )}

      {/* Step output (shown for done/running steps with content) */}
      {step.content && (
        <Box paddingLeft={2} flexDirection="column">
          {step.content.split("\n").slice(0, 20).map((line, i) => (
            <Text key={i} wrap="wrap">{line}</Text>
          ))}
          {step.content.split("\n").length > 20 && (
            <Text color={theme.textDim} dimColor>[...截断]</Text>
          )}
        </Box>
      )}
    </Box>
  );
}

function getToolPreface(toolUse: unknown): string | undefined {
  const preface =
    typeof toolUse === "object" && toolUse !== null && "preface" in toolUse
      ? toolUse.preface
      : undefined;
  return typeof preface === "string" && preface.trim()
    ? preface
    : undefined;
}

function isLowSignalToolUse(toolUse: RenderableToolUse): boolean {
  if (!toolUse.result.ok) return false;
  const content = toolUse.result.content.trim();
  return content === "" || content === "(no output)";
}

function compactLowSignalToolUses<T extends RenderableToolUse>(toolUses: T[]): T[] {
  const display: T[] = [];
  let pendingLowSignal: T | undefined;

  for (const toolUse of toolUses) {
    if (isLowSignalToolUse(toolUse)) {
      pendingLowSignal = toolUse;
      continue;
    }
    pendingLowSignal = undefined;
    display.push(toolUse);
  }

  if (pendingLowSignal) display.push(pendingLowSignal);
  return display;
}

const GROUPABLE_TOOL_NAMES = new Set(["read_file", "list_dir", "grep", "glob"]);

function compactGroupedToolUses<T extends RenderableToolUse>(toolUses: T[]): T[] {
  const result: T[] = [];
  let group: T[] = [];

  function flushGroup(): void {
    if (group.length === 0) return;
    if (group.length === 1) {
      result.push(group[0]!);
    } else {
      const counts = new Map<string, number>();
      for (const item of group) counts.set(item.name, (counts.get(item.name) ?? 0) + 1);
      const summary = [...counts.entries()]
        .map(([name, count]) => `${count} ${name}`)
        .join(", ");
      result.push({
        name: "tool_group",
        args: {},
        result: {
          ok: true,
          content: `Grouped ${group.length} read/search/list tool calls: ${summary}`,
        },
      } as T);
    }
    group = [];
  }

  for (const toolUse of toolUses) {
    if (toolUse.result.ok && GROUPABLE_TOOL_NAMES.has(toolUse.name)) {
      group.push(toolUse);
    } else {
      flushGroup();
      result.push(toolUse);
    }
  }
  flushGroup();
  return result;
}

function toolUsesForDisplay<T extends RenderableToolUse>(toolUses: T[], expanded?: boolean): T[] {
  return expanded ? toolUses : compactGroupedToolUses(compactLowSignalToolUses(toolUses));
}

function PlanMessageView({
  msg,
  width,
  expandToolOutput,
}: {
  msg: ChatMessage;
  width: number;
  expandToolOutput?: boolean;
}) {
  const steps = msg.planSteps ?? [];
  const doneCount = steps.filter((s) => s.status === "done").length;
  const total = steps.length;

  const headerText = total > 0
    ? `执行计划 — ${total} 步${msg.streaming ? ` (${doneCount}/${total} 完成)` : " ✓"}`
    : "规划中...";

  return (
    <Box flexDirection="column">
      <Text color={theme.suggestion} bold>{"● "}{headerText}</Text>
      {steps.length > 0 && (
        <Box flexDirection="column" paddingLeft={2} marginTop={1}>
          {steps.map((step, i) => (
            <PlanStepRow
              key={step.id}
              step={step}
              isActive={msg.activeStepIndex === i}
              width={width - 2}
              expandToolOutput={expandToolOutput}
            />
          ))}
        </Box>
      )}
      {/* Fallback error text */}
      {!msg.planMode && msg.content && (
        <Box paddingLeft={2}>
          <Text color={theme.error}>{msg.content}</Text>
        </Box>
      )}
    </Box>
  );
}

// ── Line count estimation ─────────────────────────────────────────────────────

function estimateToolUseLines(
  toolUses: RenderableToolUse[],
  expanded?: boolean,
): number {
  const displayed = toolUsesForDisplay(toolUses, expanded);
  if (!expanded) return displayed.length * TOOL_RESULT_ESTIMATED_LINES;
  return displayed.reduce((sum, toolUse) => {
    return sum + 3 + toolUse.result.content.split("\n").length;
  }, 0);
}

function estimateMessageLines(msg: ChatMessage, wrapWidth: number, expandToolOutput?: boolean): number {
  if (msg.planMode || msg.planSteps !== undefined) {
    let lines = 2; // header + marginBottom
    for (const step of (msg.planSteps ?? [])) {
      lines += 1; // step header line
      if (step.content) {
        const n = step.content.split("\n").length;
        lines += Math.min(n, 20);
        if (n > 20) lines += 1; // truncation indicator
      }
      lines += estimateToolUseLines(step.toolUses, expandToolOutput);
      if (step.status === "running" || (step.status === "done" && step.content)) lines += 1; // marginBottom
    }
    return lines;
  }

  const raw = msg.content + (msg.streaming ? "▌" : "");
  const rawLines = raw.split("\n");
  let lineCount = 0;
  for (const rawLine of rawLines) {
    if (!rawLine) { lineCount++; continue; }
    lineCount += Math.ceil(rawLine.length / wrapWidth) || 1;
  }
  lineCount += estimateToolUseLines(msg.toolUses ?? [], expandToolOutput);
  lineCount += 1; // marginBottom
  return lineCount;
}

// ── Main panel ────────────────────────────────────────────────────────────────

export function ConversationPanel({
  messages,
  width,
  availableHeight,
  scrollOffset,
  expandToolOutput,
  onScrollAdjust,
}: ConversationPanelProps) {
  const wrapWidth = Math.max(1, width - 3);

  // Compute per-message line estimates
  const lineCounts = messages.map((m) => estimateMessageLines(m, wrapWidth, expandToolOutput));
  const totalLines = lineCounts.reduce((a, b) => a + b, 0);

  // Scroll anchor: when user has scrolled up and new content arrives, compensate
  // the offset so the visible window stays fixed rather than drifting downward.
  const prevTotalLinesRef = useRef<number | null>(null);
  useEffect(() => {
    if (prevTotalLinesRef.current === null) {
      prevTotalLinesRef.current = totalLines;
      return;
    }
    const delta = totalLines - prevTotalLinesRef.current;
    prevTotalLinesRef.current = totalLines;
    if (delta > 0 && scrollOffset > 0) onScrollAdjust?.(delta);
  });

  // Determine the visible window [viewStart, viewEnd) in line space
  const clampedOffset = Math.max(0, Math.min(scrollOffset, Math.max(0, totalLines - availableHeight)));
  const viewEnd = totalLines - clampedOffset;
  const viewStart = viewEnd - availableHeight;

  // Find which messages fall within [viewStart, viewEnd)
  let cumLines = 0;
  let hiddenAbove = 0;
  let firstVisibleIndex = -1;
  const visibleMessages: ChatMessage[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msgEnd = cumLines + lineCounts[i]!;
    if (msgEnd <= viewStart) {
      hiddenAbove++;
    } else {
      if (firstVisibleIndex === -1) firstVisibleIndex = i;
      visibleMessages.push(messages[i]!);
    }
    cumLines = msgEnd;
  }

  if (
    hiddenAbove > 0 &&
    firstVisibleIndex > 0 &&
    visibleMessages[0]?.role === "assistant"
  ) {
    for (let i = firstVisibleIndex - 1; i >= 0; i--) {
      if (messages[i]?.role === "user") {
        visibleMessages.unshift(messages[i]!);
        hiddenAbove = Math.max(0, hiddenAbove - 1);
        break;
      }
    }
  }

  return (
    <Box flexDirection="column" width={width}>
      {/* Hidden messages indicator */}
      {hiddenAbove > 0 && (
        <Box>
          <Text color={theme.textDim} dimColor>↑ {hiddenAbove} 条消息已隐藏  (PageUp 向上滚动)</Text>
        </Box>
      )}

      {visibleMessages.map((msg, msgIdx) => {
        const isUser = msg.role === "user";

        // Plan mode message
        if (msg.planMode || (msg.role === "assistant" && msg.planSteps !== undefined)) {
          return (
            <Box key={msgIdx} flexDirection="column" marginBottom={1}>
              <PlanMessageView msg={msg} width={width} expandToolOutput={expandToolOutput} />
            </Box>
          );
        }

        const raw = msg.content + (msg.streaming ? "▌" : "");
        const rawLines = raw.split("\n");

        const contentLines: string[] = [];
        for (const rawLine of rawLines) {
          if (!rawLine) {
            contentLines.push("");
            continue;
          }
          for (let i = 0; i < rawLine.length; i += wrapWidth) {
            contentLines.push(rawLine.slice(i, i + wrapWidth));
          }
        }

        return (
          <Box key={msgIdx} flexDirection="column" marginBottom={1}>
            {/* Tool uses — shown before assistant text */}
            {msg.toolUses && msg.toolUses.length > 0 && (
              <Box flexDirection="column" marginBottom={1} paddingLeft={2}>
                {toolUsesForDisplay(msg.toolUses, expandToolOutput).map((tu, tuIdx) => (
                  <ToolResultView
                    key={tuIdx}
                    toolName={tu.name}
                    args={tu.args}
                    result={tu.result}
                    width={width - 2}
                    preface={tu.preface}
                    expanded={expandToolOutput}
                  />
                ))}
              </Box>
            )}

            {/* Message text */}
            {contentLines.map((line, lineIdx) => (
              <Box key={lineIdx}>
                {isUser ? (
                  <>
                    <Text color={theme.success} bold>{">"} </Text>
                    <Text>{line}</Text>
                  </>
                ) : (
                  <>
                    {lineIdx === 0
                      ? <Text color={theme.brand}>{"● "}</Text>
                      : <Text>{"  "}</Text>
                    }
                    <Text>{line}</Text>
                  </>
                )}
              </Box>
            ))}
          </Box>
        );
      })}
    </Box>
  );
}
