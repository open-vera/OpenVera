import React from "react";
import { Box, Text } from "ink";
import { theme } from "./theme.js";
import type { ActiveTurnState } from "./state/turnStore.js";
import type { ToolUse } from "./types.js";
import { toolArgsLabel } from "./controller/toolProjection.js";

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
  const labels = turn.tools.map((tool) => formatToolLabel(tool));
  const visible = labels.slice(-MAX_TOOL_NAMES);
  const prefix = labels.length > visible.length ? `+${labels.length - visible.length} ` : "";
  return `${prefix}${visible.join(" · ")}`;
}

export function formatToolLabel(tool: Pick<ToolUse, "name" | "args">, maxArgChars = 44): string {
  const args = toolArgsLabel(tool.name, tool.args, maxArgChars);
  return args ? `${tool.name} ${args}` : tool.name;
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
  const hasThinking = turn.thinkingText.length > 0;
  const hasText = text.length > 0;

  // If there's an active tool with live output, show it prominently
  const liveLines = activeTool ? formatLiveOutput(activeTool.liveOutput) : [];

  if (!hasThinking && !text && !tools && !activeTool) return null;

  return (
    <Box flexDirection="column">
      {/* Thinking indicator */}
      {hasThinking && !activeTool && (
        <Box>
          <Text color={theme.thinkingLabel} dimColor italic>think </Text>
          <Text color={theme.thinkingText} dimColor wrap="truncate-end">
            {formatActivityText(turn.thinkingText, 80)}
          </Text>
        </Box>
      )}

      {/* If there's an active tool with live output, show it prominently */}
      {activeTool ? (
        <Box flexDirection="column">
          <Box>
            <Text color={theme.toolName}>exec </Text>
            <Text color={theme.suggestion} bold>{activeTool.name}</Text>
            {toolArgsLabel(activeTool.name, activeTool.args) && (
              <Text color={theme.textDim}> {toolArgsLabel(activeTool.name, activeTool.args)}</Text>
            )}
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
      {hasText && !activeTool ? (
        <Box>
          <Text color={theme.brand}>live  </Text>
          <Text color={theme.textDim} wrap="truncate-end">{text}</Text>
        </Box>
      ) : null}
    </Box>
  );
}
