import { Box, Text } from "ink";
import { theme } from "./theme.js";
import type { ActiveTurnState } from "./state/turnStore.js";

const MAX_TEXT_CHARS = 120;
const MAX_TOOL_NAMES = 4;

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

interface ActivityLaneProps {
  turn: ActiveTurnState;
}

export function ActivityLane({ turn }: ActivityLaneProps) {
  if (!turn.active) return null;

  const text = formatActivityText(turn.text);
  const tools = formatActivityTools(turn);

  if (!text && !tools) return null;

  return (
    <Box flexDirection="column">
      {tools ? (
        <Box>
          <Text color={theme.toolName}>tools </Text>
          <Text color={theme.textDim}>{tools}</Text>
        </Box>
      ) : null}
      {text ? (
        <Box>
          <Text color={theme.brand}>live  </Text>
          <Text color={theme.textDim} wrap="truncate-end">{text}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

