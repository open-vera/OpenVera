import { Box, Text } from "ink";
import { useState } from "react";
import type { Question, QuestionAnswers } from "../../../tools/ask-user-question.js";
import { theme } from "../theme.js";
import { QuestionNavBar } from "./QuestionNavBar.js";
import { QuestionOptionList } from "./QuestionOptionList.js";

interface Props {
  question: Question;
  questions: Question[];
  currentQuestionIndex: number;
  answers: QuestionAnswers;
  selectedValues: string[];
  hideSubmitTab?: boolean;
  columns: number;
  onSelect: (label: string) => void;
  onToggle: (label: string) => void;
  onCommit: () => void;
  onCancel: () => void;
  onTabPrev?: () => void;
  onTabNext?: () => void;
  submitButtonText?: string;
}

const OPTION_PANEL_WIDTH = 30;

export function PreviewLayout({
  question,
  questions,
  currentQuestionIndex,
  answers,
  selectedValues,
  hideSubmitTab,
  columns,
  onSelect,
  onToggle,
  onCommit,
  onCancel,
  onTabPrev,
  onTabNext,
  submitButtonText,
}: Props) {
  const [focusedIndex, setFocusedIndex] = useState(0);
  const previewWidth = Math.max(20, columns - OPTION_PANEL_WIDTH - 8);

  const focusedOption = question.options[focusedIndex];
  const previewContent = focusedOption?.preview ?? "";

  return (
    <Box flexDirection="column">
      <QuestionNavBar
        questions={questions}
        currentQuestionIndex={currentQuestionIndex}
        answers={answers}
        hideSubmitTab={hideSubmitTab}
      />
      <Text bold>{question.question}</Text>

      <Box marginTop={1} flexDirection="row" gap={4}>
        {/* Left: option list */}
        <Box flexDirection="column" width={OPTION_PANEL_WIDTH}>
          <QuestionOptionList
            options={question.options}
            multiSelect={question.multiSelect ?? false}
            selectedValues={selectedValues}
            onSelect={onSelect}
            onToggle={onToggle}
            onCommit={onCommit}
            onCancel={onCancel}
            onFocusChange={setFocusedIndex}
            submitButtonText={submitButtonText}
          />
        </Box>

        {/* Right: preview */}
        <Box flexDirection="column" flexGrow={1} borderStyle="single" borderColor={theme.textSubtle} paddingX={1} width={previewWidth}>
          {previewContent ? (
            <Text wrap="wrap">{previewContent}</Text>
          ) : (
            <Text color={theme.textDim} dimColor>No preview available</Text>
          )}
        </Box>
      </Box>

      <Box marginTop={1}>
        <Text color={theme.textSubtle}>
          {question.multiSelect
            ? "↑↓ navigate  space/enter toggle  tab switch questions  esc cancel"
            : "↑↓ navigate  enter select  tab switch questions  esc cancel"}
        </Text>
      </Box>
    </Box>
  );
}
