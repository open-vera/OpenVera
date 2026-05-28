import { Box, Text } from "ink";
import { theme } from "./theme.js";
import type { ActiveTurnState } from "./state/turnStore.js";

const MAX_TEXT_CHARS = 120;
const MAX_TOOL_NAMES = 4;
const MAX_LIVE_LINES = 5;

export function formatActivityText(text: string, maxChars = MAX_TEXT_CHARS): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= maxChars) return compact;
  return `${compact.slice(0, Math.max(0, maxChars - 1))}…`;
}

export function formatActivityTools(turn: ActiveTurnState): string {
  if (turn.tools.length === 0) return "";
  const names = turn.tools.map((tool) => tool.name);
  const visible = names.slice(-MAX_TOOL_NAMES);
  const prefix = names.length > visible.length ? `+${names.length - visible.length} ` : "";
  return `${prefix}${visible.join(" · ")}`;
}

function formatLiveOutput(output: string): string[] {
  const lines = output.split("\n");
  // Remove trailing empty line (common from data chunks)
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  if (lines.length <= MAX_LIVE_LINES) return lines;
  return lines.slice(-MAX_LIVE_LINES);
}

interface ActivityLaneProps {
  turn: ActiveTurnState;
}

export function ActivityLane({ turn }: ActivityLaneProps) {
  if (!turn.active) return null;

  const text = formatActivityText(turn.text);
  const tools = formatActivityTools(turn);
  const activeTool = turn.activeTool;

  // If there's an active tool with live output, show it prominently
  const liveLines = activeTool ? formatLiveOutput(activeTool.liveOutput) : [];

  if (!text && !tools && !activeTool) return null;

  return (
    <Box flexDirection="column">
      {activeTool ? (
        <Box flexDirection="column">
          <Box>
            <Text color={theme.toolName}>exec </Text>
            <Text color={theme.suggestion} bold>{activeTool.name}</Text>
            {liveLines.length > 0 && (
              <Text color={theme.textDim}> {"\u2026"}</Text>
            )}
          </Box>
          {liveLines.map((line, i) => (
            <Text key={i} color={theme.textDim} wrap="truncate-end">  {"\u2502"} {line}</Text>
          ))}
        </Box>
      ) : tools ? (
        <Box>
          <Text color={theme.toolName}>tools </Text>
          <Text color={theme.textDim}>{tools}</Text>
        </Box>
      ) : null}
      {text && !activeTool ? (
        <Box>
          <Text color={theme.brand}>live  </Text>
          <Text color={theme.textDim} wrap="truncate-end">{text}</Text>
        </Box>
      ) : null}
    </Box>
  );
}
