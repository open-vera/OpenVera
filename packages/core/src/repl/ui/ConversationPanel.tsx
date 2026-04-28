import { Box, Text } from "ink";
import type { ChatMessage, PlanStepUI } from "./types.js";
import { ToolResultView } from "./ToolResultView.js";

interface ConversationPanelProps {
  messages: ChatMessage[];
  width: number;
  availableHeight: number;
  scrollOffset: number; // lines scrolled up from bottom (0 = follow bottom)
}

// ── Plan step renderer ────────────────────────────────────────────────────────

const STEP_ICONS = {
  pending: "○",
  running: "▶",
  done:    "✓",
  failed:  "✗",
} as const;

const STEP_COLORS = {
  pending: "gray",
  running: "cyan",
  done:    "green",
  failed:  "red",
} as const;

function PlanStepRow({ step, isActive, width }: { step: PlanStepUI; isActive: boolean; width: number }) {
  const icon = STEP_ICONS[step.status];
  const color = STEP_COLORS[step.status];

  return (
    <Box flexDirection="column" marginBottom={step.status === "running" || (step.status === "done" && step.content) ? 1 : 0}>
      {/* Step header */}
      <Box>
        <Text color={color} bold={isActive}>{icon} </Text>
        <Text color={isActive ? "white" : "gray"} bold={isActive}>{step.description}</Text>
        {step.status === "running" && <Text color="cyan"> ▌</Text>}
      </Box>

      {/* Tool uses */}
      {step.toolUses.length > 0 && (
        <Box flexDirection="column" paddingLeft={2}>
          {step.toolUses.map((tu, i) => (
            <ToolResultView
              key={i}
              toolName={tu.name}
              args={tu.args}
              result={tu.result}
              width={width - 2}
            />
          ))}
        </Box>
      )}

      {/* Step output (shown for done/running steps with content) */}
      {step.content && (
        <Box paddingLeft={2} flexDirection="column">
          {step.content.split("\n").slice(0, 20).map((line, i) => (
            <Text key={i} color="gray" wrap="wrap">{line}</Text>
          ))}
          {step.content.split("\n").length > 20 && (
            <Text color="gray" dimColor>[...截断]</Text>
          )}
        </Box>
      )}
    </Box>
  );
}

function PlanMessageView({ msg, width }: { msg: ChatMessage; width: number }) {
  const steps = msg.planSteps ?? [];
  const doneCount = steps.filter((s) => s.status === "done").length;
  const total = steps.length;

  const headerText = total > 0
    ? `执行计划 — ${total} 步${msg.streaming ? ` (${doneCount}/${total} 完成)` : " ✓"}`
    : "规划中...";

  return (
    <Box flexDirection="column">
      <Text color="blue" bold>{"● "}{headerText}</Text>
      {steps.length > 0 && (
        <Box flexDirection="column" paddingLeft={2} marginTop={1}>
          {steps.map((step, i) => (
            <PlanStepRow
              key={step.id}
              step={step}
              isActive={msg.activeStepIndex === i}
              width={width - 2}
            />
          ))}
        </Box>
      )}
      {/* Fallback error text */}
      {!msg.planMode && msg.content && (
        <Box paddingLeft={2}>
          <Text color="red">{msg.content}</Text>
        </Box>
      )}
    </Box>
  );
}

// ── Line count estimation ─────────────────────────────────────────────────────

function estimateMessageLines(msg: ChatMessage, wrapWidth: number): number {
  if (msg.planMode || msg.planSteps !== undefined) {
    let lines = 2; // header + marginBottom
    for (const step of (msg.planSteps ?? [])) {
      lines += 1; // step header line
      if (step.content) {
        const n = step.content.split("\n").length;
        lines += Math.min(n, 20);
        if (n > 20) lines += 1; // truncation indicator
      }
      lines += step.toolUses.length * 3; // rough estimate per tool use
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
  lineCount += (msg.toolUses?.length ?? 0) * 3;
  lineCount += 1; // marginBottom
  return lineCount;
}

// ── Main panel ────────────────────────────────────────────────────────────────

export function ConversationPanel({ messages, width, availableHeight, scrollOffset }: ConversationPanelProps) {
  const wrapWidth = Math.max(1, width - 3);

  // Compute per-message line estimates
  const lineCounts = messages.map((m) => estimateMessageLines(m, wrapWidth));
  const totalLines = lineCounts.reduce((a, b) => a + b, 0);

  // Determine the visible window [viewStart, viewEnd) in line space
  const clampedOffset = Math.max(0, Math.min(scrollOffset, Math.max(0, totalLines - availableHeight)));
  const viewEnd = totalLines - clampedOffset;
  const viewStart = viewEnd - availableHeight;

  // Find which messages fall within [viewStart, viewEnd)
  let cumLines = 0;
  let hiddenAbove = 0;
  const visibleMessages: ChatMessage[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msgEnd = cumLines + lineCounts[i]!;
    if (msgEnd <= viewStart) {
      hiddenAbove++;
    } else {
      visibleMessages.push(messages[i]!);
    }
    cumLines = msgEnd;
  }

  return (
    <Box flexDirection="column" width={width}>
      {/* Hidden messages indicator */}
      {hiddenAbove > 0 && (
        <Box>
          <Text color="gray" dimColor>↑ {hiddenAbove} 条消息已隐藏  (PageUp 向上滚动)</Text>
        </Box>
      )}

      {visibleMessages.map((msg, msgIdx) => {
        const isUser = msg.role === "user";

        // Plan mode message
        if (msg.planMode || (msg.role === "assistant" && msg.planSteps !== undefined)) {
          return (
            <Box key={msgIdx} flexDirection="column" marginBottom={1}>
              <PlanMessageView msg={msg} width={width} />
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
                {msg.toolUses.map((tu, tuIdx) => (
                  <ToolResultView
                    key={tuIdx}
                    toolName={tu.name}
                    args={tu.args}
                    result={tu.result}
                    width={width - 2}
                  />
                ))}
              </Box>
            )}

            {/* Message text */}
            {contentLines.map((line, lineIdx) => (
              <Box key={lineIdx}>
                {isUser ? (
                  <>
                    <Text color="green" bold>{">"} </Text>
                    <Text>{line}</Text>
                  </>
                ) : (
                  <>
                    {lineIdx === 0
                      ? <Text color="blue">{"● "}</Text>
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
