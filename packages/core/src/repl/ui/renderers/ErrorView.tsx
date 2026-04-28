import { Box, Text } from "ink";

interface ErrorViewProps {
  message: string;
  code?: string;
}

export function ErrorView({ message, code }: ErrorViewProps) {
  return (
    <Box flexDirection="column">
      {code && (
        <Text color="red" bold>{code}</Text>
      )}
      <Text color="red">{message}</Text>
    </Box>
  );
}
