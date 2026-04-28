import { Box, Text } from "ink";
import type { Question, QuestionAnswers } from "../../../tools/ask-user-question.js";
import { theme } from "../theme.js";

interface Props {
  questions: Question[];
  currentQuestionIndex: number;
  answers: QuestionAnswers;
  hideSubmitTab?: boolean;
}

export function QuestionNavBar({ questions, currentQuestionIndex, answers, hideSubmitTab = false }: Props) {
  const showArrows = !(questions.length === 1 && hideSubmitTab);
  const atStart = currentQuestionIndex === 0;
  const atEnd = currentQuestionIndex === questions.length;

  return (
    <Box flexDirection="row" marginBottom={1}>
      {showArrows && (
        <Text color={atStart ? theme.textSubtle : theme.text}>{"← "}</Text>
      )}

      {questions.map((q, i) => {
        const isActive = i === currentQuestionIndex;
        const isAnswered = !!answers[q.question];
        const checkbox = isAnswered ? "☑" : "☐";
        const label = q.header ?? `Q${i + 1}`;

        return (
          <Box key={q.question}>
            {isActive ? (
              <Text backgroundColor={theme.suggestion} color="black">
                {" "}{checkbox} {label}{" "}
              </Text>
            ) : (
              <Text color={theme.textDim}>
                {" "}{checkbox} {label}{" "}
              </Text>
            )}
          </Box>
        );
      })}

      {!hideSubmitTab && (
        <Box>
          {currentQuestionIndex === questions.length ? (
            <Text backgroundColor={theme.success} color="black">
              {" "}✓ Submit{" "}
            </Text>
          ) : (
            <Text color={theme.textDim}>{" "}✓ Submit{" "}</Text>
          )}
        </Box>
      )}

      {showArrows && (
        <Text color={atEnd ? theme.textSubtle : theme.text}>{" →"}</Text>
      )}
    </Box>
  );
}
