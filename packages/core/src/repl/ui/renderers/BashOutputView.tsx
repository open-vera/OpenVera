import { Box, Text } from "ink";
import { theme } from "../theme.js";

const MAX_LINES = 3;

interface BashOutputViewProps {
  content: string;
  exitCode: number;
  width: number;
  expanded?: boolean;
}

export function BashOutputView({ content, exitCode, width, expanded }: BashOutputViewProps) {
  const lines = content.split("\n");
  const truncated = !expanded && lines.length > MAX_LINES;
  const visible = truncated ? lines.slice(0, MAX_LINES) : lines;
  const remaining = lines.length - MAX_LINES;
  const success = exitCode === 0;

  return (
    <Box flexDirection="column" width={width}>
      {!success && (
        <Text color={theme.error} bold>
          exit {exitCode}
        </Text>
      )}
      {visible.map((line, i) => (
        <Text key={i} wrap="wrap">{line}</Text>
      ))}
      {truncated && (
        <Text color={theme.textDim}>[... +{remaining} lines]</Text>
      )}
    </Box>
  );
}
