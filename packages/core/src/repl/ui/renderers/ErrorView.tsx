import { Box, Text } from "ink";
import { theme } from "../theme.js";

interface ErrorViewProps {
  message: string;
  code?: string;
}

export function ErrorView({ message, code }: ErrorViewProps) {
  return (
    <Box flexDirection="column">
      {code && (
        <Text color={theme.error} bold>{code}</Text>
      )}
      <Text color={theme.error}>{message}</Text>
    </Box>
  );
}
