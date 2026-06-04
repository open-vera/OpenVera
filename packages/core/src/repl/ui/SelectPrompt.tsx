import { useInput, Box, Text } from "ink";
import { useState } from "react";
import { theme } from "./theme.js";

export interface SelectOption<T = string> {
  value: T;
  label: string;
  description?: string;
  groupHeader?: boolean;
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
  const getFirstReal = (): number => {
    for (let i = 0; i < options.length; i++) {
      if (!options[i]!.groupHeader) return i;
    }
    return -1;
  };
  const [focusedIndex, setFocusedIndex] = useState(getFirstReal());
  const [selectedValues, setSelectedValues] = useState<Set<T>>(new Set());

  useInput((input, key) => {
    if (key.upArrow) {
      setFocusedIndex((prev) => {
        let next = prev;
        for (let i = 0; i < options.length; i++) {
          next = (next - 1 + options.length) % options.length;
          if (!options[next]!.groupHeader) return next;
        }
        return prev;
      });
    } else if (key.downArrow) {
      setFocusedIndex((prev) => {
        let next = prev;
        for (let i = 0; i < options.length; i++) {
          next = (next + 1) % options.length;
          if (!options[next]!.groupHeader) return next;
        }
        return prev;
      });
    } else if (input === " " && multiSelect) {
      const option = options[focusedIndex];
      if (!option || option.groupHeader) return;
      setSelectedValues((prev) => {
        const next = new Set(prev);
        if (next.has(option.value)) next.delete(option.value);
        else next.add(option.value);
        return next;
      });
    } else if (key.return) {
      if (multiSelect) {
        onConfirm([...selectedValues]);
      } else {
        const focused = options[focusedIndex];
        if (focused && !focused.groupHeader) onConfirm([focused.value]);
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
          if (option.groupHeader) {
            return (
              <Box key={index}>
                <Text color={theme.textDim}>  {option.label}</Text>
                {option.description && (
                  <Text color={theme.textSubtle}> {option.description}</Text>
                )}
              </Box>
            );
          }
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
