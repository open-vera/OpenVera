import { Box, Text } from "ink";

interface FileListViewProps {
  content: string;
}

export function FileListView({ content }: FileListViewProps) {
  const lines = content.split("\n");
  return (
    <Box flexDirection="column">
      {lines.map((line, i) => (
        <Text key={i} color={line.startsWith("📁") ? "cyan" : undefined}>{line}</Text>
      ))}
    </Box>
  );
}
