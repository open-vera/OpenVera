import { Box, Text } from "ink";

const MAX_LINES = 50;

interface TextViewProps {
  content: string;
  width: number;
}

export function TextView({ content, width }: TextViewProps) {
  const lines = content.split("\n");
  const truncated = lines.length > MAX_LINES;
  const visible = truncated ? lines.slice(0, MAX_LINES) : lines;
  const remaining = lines.length - MAX_LINES;

  return (
    <Box flexDirection="column" width={width}>
      {visible.map((line, i) => (
        <Text key={i} wrap="wrap">{line}</Text>
      ))}
      {truncated && (
        <Text color="gray">[... {remaining} more lines]</Text>
      )}
    </Box>
  );
}
