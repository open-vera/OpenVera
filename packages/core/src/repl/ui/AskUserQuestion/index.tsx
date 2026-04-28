import { useInput, Box } from "ink";
import type { AskUserQuestionArgs, QuestionAnswers } from "../../../tools/ask-user-question.js";
import { useMultipleChoiceState } from "./useMultipleChoiceState.js";
import { QuestionView } from "./QuestionView.js";
import { SubmitView } from "./SubmitView.js";

export interface AskUserQuestionState {
  questions: AskUserQuestionArgs["questions"];
  resolve: (answers: QuestionAnswers) => void;
}

interface Props {
  state: AskUserQuestionState;
  columns: number;
}

export function AskUserQuestion({ state: { questions, resolve }, columns }: Props) {
  const {
    currentQuestionIndex,
    answers,
    selectedValues,
    nextQuestion,
    prevQuestion,
    setAnswer,
    toggleSelection,
    commitMultiSelect,
  } = useMultipleChoiceState();

  const isOnSubmitView = currentQuestionIndex >= questions.length;
  const allAnswered = questions.every((q) => !!answers[q.question]);

  const handleSubmit = () => resolve(answers);
  const handleCancel = () => resolve({});

  const handleTabNext = () => {
    if (currentQuestionIndex < questions.length) nextQuestion();
  };
  const handleTabPrev = () => prevQuestion(questions.length);

  // Allow Tab from anywhere to navigate between questions
  useInput((input, key) => {
    if (!key.tab) return;
    if (key.shift) {
      handleTabPrev();
    } else {
      handleTabNext();
    }
  });

  if (isOnSubmitView) {
    return (
      <Box flexDirection="column" marginTop={1}>
        <SubmitView
          questions={questions}
          currentQuestionIndex={currentQuestionIndex}
          answers={answers}
          allAnswered={allAnswered}
          onSubmit={handleSubmit}
          onCancel={handleCancel}
          onTabPrev={handleTabPrev}
        />
      </Box>
    );
  }

  const question = questions[currentQuestionIndex]!;
  const qKey = question.question;
  const qSelectedValues = selectedValues[qKey] ?? [];

  const handleSelect = (label: string) => {
    setAnswer(qKey, label, true);
  };

  const handleToggle = (label: string) => {
    toggleSelection(qKey, label);
  };

  const handleCommit = () => {
    commitMultiSelect(qKey, true);
  };

  return (
    <Box flexDirection="column" marginTop={1}>
      <QuestionView
        question={question}
        questions={questions}
        currentQuestionIndex={currentQuestionIndex}
        answers={answers}
        selectedValues={qSelectedValues}
        columns={columns}
        onSelect={handleSelect}
        onToggle={handleToggle}
        onCommit={handleCommit}
        onCancel={handleCancel}
        onTabPrev={handleTabPrev}
        onTabNext={handleTabNext}
      />
    </Box>
  );
}
