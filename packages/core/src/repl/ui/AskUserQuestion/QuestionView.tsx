import { useInput, Box, Text } from "ink";
import type { Question, QuestionAnswers } from "../../../tools/ask-user-question.js";
import { theme } from "../theme.js";
import { PreviewLayout } from "./PreviewLayout.js";
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
}

export function QuestionView({
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
}: Props) {
  const hasPreview = !question.multiSelect && question.options.some((o) => o.preview);

  const submitButtonText =
    currentQuestionIndex === questions.length - 1 ? "Submit" : "Next";

  useInput((input, key) => {
    if (key.tab) {
      if (key.shift) {
        onTabPrev?.();
      } else {
        onTabNext?.();
      }
    }
  });

  if (hasPreview) {
    return (
      <PreviewLayout
        question={question}
        questions={questions}
        currentQuestionIndex={currentQuestionIndex}
        answers={answers}
        selectedValues={selectedValues}
        hideSubmitTab={hideSubmitTab}
        columns={columns}
        onSelect={onSelect}
        onToggle={onToggle}
        onCommit={onCommit}
        onCancel={onCancel}
        onTabPrev={onTabPrev}
        onTabNext={onTabNext}
        submitButtonText={submitButtonText}
      />
    );
  }

  return (
    <Box flexDirection="column">
      <QuestionNavBar
        questions={questions}
        currentQuestionIndex={currentQuestionIndex}
        answers={answers}
        hideSubmitTab={hideSubmitTab}
      />
      <Text bold>{question.question}</Text>

      <Box marginTop={1}>
        <QuestionOptionList
          options={question.options}
          multiSelect={question.multiSelect ?? false}
          selectedValues={selectedValues}
          onSelect={onSelect}
          onToggle={onToggle}
          onCommit={onCommit}
          onCancel={onCancel}
          submitButtonText={submitButtonText}
        />
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
