import { useInput, Box, Text } from "ink";
import { useState } from "react";
import { theme } from "./theme.js";

export interface SelectOption<T = string> {
  value: T;
  label: string;
  description?: string;
}

interface SelectPromptProps<T = string> {
  message: string;
  options: SelectOption<T>[];
  multiSelect?: boolean;
  onConfirm: (selected: T[]) => void;
  onCancel: () => void;
}

export function SelectPrompt<T = string>({
  message,
  options,
  multiSelect = false,
  onConfirm,
  onCancel,
}: SelectPromptProps<T>) {
  const [focusedIndex, setFocusedIndex] = useState(0);
  const [selectedValues, setSelectedValues] = useState<Set<T>>(new Set());

  useInput((input, key) => {
    if (key.upArrow) {
      setFocusedIndex((prev) => (prev - 1 + options.length) % options.length);
    } else if (key.downArrow) {
      setFocusedIndex((prev) => (prev + 1) % options.length);
    } else if (input === " " && multiSelect) {
      const value = options[focusedIndex]!.value;
      setSelectedValues((prev) => {
        const next = new Set(prev);
        if (next.has(value)) next.delete(value);
        else next.add(value);
        return next;
      });
    } else if (key.return) {
      if (multiSelect) {
        onConfirm([...selectedValues]);
      } else {
        const focused = options[focusedIndex];
        if (focused) onConfirm([focused.value]);
      }
    } else if (key.escape || (key.ctrl && input === "c")) {
      onCancel();
    }
  });

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={theme.warning}>⚠  {message}</Text>
      <Box flexDirection="column" marginTop={1}>
        {options.map((option, index) => {
          const isFocused = index === focusedIndex;
          const isSelected = selectedValues.has(option.value);

          return (
            <Box key={index}>
              <Text color={isFocused ? theme.suggestion : theme.textDim}>{isFocused ? "❯" : " "} </Text>
              {multiSelect && (
                <Text color={isSelected ? theme.success : theme.textDim}>{isSelected ? "✓" : " "} </Text>
              )}
              <Text color={isSelected ? theme.success : isFocused ? theme.suggestion : theme.text} bold={isFocused}>
                {option.label}
              </Text>
              {option.description && (
                <Text color={theme.textDim}> — {option.description}</Text>
              )}
            </Box>
          );
        })}
      </Box>
      <Box marginTop={1}>
        <Text color={theme.textSubtle}>
          {multiSelect
            ? "↑↓ navigate  space select  enter confirm  esc cancel"
            : "↑↓ navigate  enter confirm  esc cancel"}
        </Text>
      </Box>
    </Box>
  );
}
