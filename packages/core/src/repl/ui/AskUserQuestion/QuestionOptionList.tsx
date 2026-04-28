import { useInput, Box, Text } from "ink";
import { useState } from "react";
import type { QuestionOption } from "../../../tools/ask-user-question.js";
import { theme } from "../theme.js";

interface Props {
  options: QuestionOption[];
  multiSelect: boolean;
  selectedValues: string[];
  /** Compact: number + label only. Full: number + label + description below */
  indexWidth?: number;
  onSelect: (label: string) => void;
  onToggle: (label: string) => void;
  onCommit: () => void;
  onCancel: () => void;
  onFocusChange?: (index: number) => void;
  /** Called when user presses Down on last item (incl. Submit button) */
  onDownFromLast?: () => void;
  /** Called when user presses Up from first item */
  onUpFromFirst?: () => void;
  isDisabled?: boolean;
  submitButtonText?: string;
}

export function QuestionOptionList({
  options,
  multiSelect,
  selectedValues,
  indexWidth,
  onSelect,
  onToggle,
  onCommit,
  onCancel,
  onFocusChange,
  onDownFromLast,
  onUpFromFirst,
  isDisabled = false,
  submitButtonText = "Submit",
}: Props) {
  // In multi-select mode the last "item" is the Submit button
  const totalItems = multiSelect ? options.length + 1 : options.length;
  const submitIndex = options.length; // only used in multiSelect mode
  const [focusedIndex, setFocusedIndex] = useState(0);

  const isFocusedOnSubmit = multiSelect && focusedIndex === submitIndex;

  const moveFocus = (delta: number) => {
    setFocusedIndex((prev) => {
      const next = prev + delta;
      if (next < 0) {
        onUpFromFirst?.();
        return prev;
      }
      if (next >= totalItems) {
        onDownFromLast?.();
        return prev;
      }
      const clamped = Math.max(0, Math.min(totalItems - 1, next));
      onFocusChange?.(clamped);
      return clamped;
    });
  };

  useInput(
    (input, key) => {
      if (isDisabled) return;

      if (key.upArrow) {
        moveFocus(-1);
      } else if (key.downArrow) {
        moveFocus(1);
      } else if (input === " " && multiSelect && !isFocusedOnSubmit) {
        onToggle(options[focusedIndex]!.label);
      } else if (key.return) {
        if (multiSelect) {
          if (isFocusedOnSubmit) {
            onCommit();
          } else {
            // Enter in multi-select toggles item + moves down
            onToggle(options[focusedIndex]!.label);
            moveFocus(1);
          }
        } else {
          onSelect(options[focusedIndex]!.label);
        }
      } else if (key.tab) {
        // Tab handled by parent for question navigation
      } else if (key.escape || (key.ctrl && input === "c")) {
        onCancel();
      }
    },
    { isActive: !isDisabled },
  );

  const iw = indexWidth ?? String(options.length).length;

  return (
    <Box flexDirection="column">
      {options.map((opt, i) => {
        const isFocused = !isDisabled && i === focusedIndex && !isFocusedOnSubmit;
        const isSelected = selectedValues.includes(opt.label);

        return (
          <Box key={opt.label} flexDirection="column">
            <Box>
              <Text color={isFocused ? theme.suggestion : theme.textDim}>
                {isFocused ? "❯" : " "}
              </Text>
              <Text color={theme.textDim}>{" "}</Text>
              {multiSelect && (
                <Text color={isSelected ? theme.success : theme.textDim}>
                  [{isSelected ? "✓" : " "}]{" "}
                </Text>
              )}
              <Text color={theme.textDim} dimColor>
                {`${i + 1}.`.padEnd(iw + 1)}
              </Text>
              <Text
                color={isSelected ? theme.success : isFocused ? theme.suggestion : undefined}
                bold={isFocused}
              >
                {opt.label}
              </Text>
              {isSelected && !multiSelect && (
                <Text color={theme.success}> ✓</Text>
              )}
            </Box>
            {opt.description && !isFocused && (
              <Box paddingLeft={multiSelect ? 6 : 4}>
                <Text color={theme.textDim} dimColor>
                  {opt.description}
                </Text>
              </Box>
            )}
            {opt.description && isFocused && (
              <Box paddingLeft={multiSelect ? 6 : 4}>
                <Text color={theme.suggestion} wrap="wrap">
                  {opt.description}
                </Text>
              </Box>
            )}
          </Box>
        );
      })}

      {multiSelect && (
        <Box marginTop={1}>
          <Text color={isFocusedOnSubmit ? theme.suggestion : theme.textDim}>
            {isFocusedOnSubmit ? "❯" : " "}
          </Text>
          <Text color={theme.textDim}>{" "}</Text>
          <Box marginLeft={iw + 2}>
            <Text
              color={isFocusedOnSubmit ? theme.suggestion : theme.textDim}
              bold={isFocusedOnSubmit}
            >
              {submitButtonText}
            </Text>
          </Box>
        </Box>
      )}
    </Box>
  );
}
