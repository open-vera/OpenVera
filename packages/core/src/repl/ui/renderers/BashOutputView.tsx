import { Box, Text } from "ink";

const MAX_LINES = 60;

interface BashOutputViewProps {
  content: string;
  exitCode: number;
  width: number;
}

export function BashOutputView({ content, exitCode, width }: BashOutputViewProps) {
  const lines = content.split("\n");
  const truncated = lines.length > MAX_LINES;
  const visible = truncated ? lines.slice(0, MAX_LINES) : lines;
  const remaining = lines.length - MAX_LINES;
  const success = exitCode === 0;

  return (
    <Box flexDirection="column" width={width}>
      <Text color={success ? "green" : "red"} bold>
        exit {exitCode}
      </Text>
      <Text color="gray">{"─".repeat(Math.min(width, 40))}</Text>
      {visible.map((line, i) => (
        <Text key={i} wrap="wrap">{line}</Text>
      ))}
      {truncated && (
        <Text color="gray">[... {remaining} more lines truncated]</Text>
      )}
    </Box>
  );
}
