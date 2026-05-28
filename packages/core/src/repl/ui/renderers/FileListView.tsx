import { Box, Text } from "ink";
import { theme } from "../theme.js";

const MAX_LINES = 5;

interface FileListViewProps {
  content: string;
  expanded?: boolean;
}

export function FileListView({ content, expanded }: FileListViewProps) {
  const lines = content.split("\n");
  const truncated = !expanded && lines.length > MAX_LINES;
  const visible = truncated ? lines.slice(0, MAX_LINES) : lines;
  const remaining = lines.length - MAX_LINES;

  return (
    <Box flexDirection="column">
      {visible.map((line, i) => (
        <Text key={i} color={line.startsWith("📁") ? theme.suggestion : undefined}>{line}</Text>
      ))}
      {truncated && (
        <Text color={theme.textDim}>[... +{remaining} items (⌥O to expand)]</Text>
      )}
    </Box>
  );
}
