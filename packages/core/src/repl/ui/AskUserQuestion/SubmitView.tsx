import { useInput, Box, Text } from "ink";
import { useState } from "react";
import type { Question, QuestionAnswers } from "../../../tools/ask-user-question.js";
import { theme } from "../theme.js";
import { QuestionNavBar } from "./QuestionNavBar.js";

interface Props {
  questions: Question[];
  currentQuestionIndex: number;
  answers: QuestionAnswers;
  allAnswered: boolean;
  onSubmit: () => void;
  onCancel: () => void;
  onTabPrev?: () => void;
}

export function SubmitView({
  questions,
  currentQuestionIndex,
  answers,
  allAnswered,
  onSubmit,
  onCancel,
  onTabPrev,
}: Props) {
  const options = ["Submit", "Cancel"] as const;
  const [focusedIndex, setFocusedIndex] = useState(0);

  useInput((input, key) => {
    if (key.upArrow) {
      setFocusedIndex((p) => Math.max(0, p - 1));
    } else if (key.downArrow) {
      setFocusedIndex((p) => Math.min(options.length - 1, p + 1));
    } else if (key.return) {
      if (focusedIndex === 0) onSubmit();
      else onCancel();
    } else if (key.tab && key.shift) {
      onTabPrev?.();
    } else if (key.escape || (key.ctrl && input === "c")) {
      onCancel();
    }
  });

  return (
    <Box flexDirection="column">
      <QuestionNavBar
        questions={questions}
        currentQuestionIndex={currentQuestionIndex}
        answers={answers}
      />
      <Text bold>Review your answers</Text>

      {!allAnswered && (
        <Box marginTop={1}>
          <Text color={theme.warning}>⚠ You have not answered all questions</Text>
        </Box>
      )}

      <Box flexDirection="column" marginTop={1}>
        {questions.map((q) => (
          <Box key={q.question} flexDirection="row" gap={1}>
            <Text color={theme.textDim}>·</Text>
            <Text color={theme.textDim}>{q.question}</Text>
            <Text color={theme.textDim}>→</Text>
            <Text color={answers[q.question] ? theme.success : theme.warning}>
              {answers[q.question] ?? "(unanswered)"}
            </Text>
          </Box>
        ))}
      </Box>

      <Box flexDirection="column" marginTop={1}>
        {options.map((label, i) => {
          const isFocused = i === focusedIndex;
          return (
            <Box key={label}>
              <Text color={isFocused ? theme.suggestion : theme.textDim}>
                {isFocused ? "❯" : " "}
              </Text>
              <Text color={isFocused ? theme.suggestion : undefined} bold={isFocused}>
                {" "}{label}
              </Text>
            </Box>
          );
        })}
      </Box>

      <Box marginTop={1}>
        <Text color={theme.textSubtle}>
          ↑↓ navigate  enter confirm  shift+tab go back  esc cancel
        </Text>
      </Box>
    </Box>
  );
}
