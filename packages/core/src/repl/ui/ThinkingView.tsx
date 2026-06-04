import React from "react";
import { Box, Text } from "ink";
import { theme } from "./theme.js";

interface ThinkingViewProps {
  thinking: string;
  maxPreviewLines?: number;
  width: number;
}

export function ThinkingView({ thinking, maxPreviewLines = 3, width }: ThinkingViewProps) {
  if (!thinking.trim()) return null;

  const lines = thinking.split("\n");
  const preview = lines.slice(0, maxPreviewLines);
  const hasMore = lines.length > maxPreviewLines;
  const maxChars = Math.max(0, width - 8);

  return (
    <Box flexDirection="column" paddingLeft={2}>
      {preview.map((line, i) => (
        <Box key={i}>
          <Text color={theme.thinkingLabel} dimColor>{"  "}</Text>
          <Text color={theme.thinkingText} dimColor italic wrap="truncate-end">
            {line.slice(0, maxChars)}
            {i === preview.length - 1 && hasMore ? "..." : ""}
          </Text>
        </Box>
      ))}
    </Box>
  );
}
