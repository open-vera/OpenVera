import { useCallback, useReducer } from "react";

type State = {
  currentQuestionIndex: number;
  answers: Record<string, string>;
  selectedValues: Record<string, string[]>;
};

type Action =
  | { type: "next-question" }
  | { type: "prev-question"; total: number }
  | { type: "set-answer"; questionText: string; answer: string; advance: boolean }
  | { type: "toggle-selection"; questionText: string; value: string }
  | { type: "commit-multi-select"; questionText: string; advance: boolean };

const INITIAL_STATE: State = {
  currentQuestionIndex: 0,
  answers: {},
  selectedValues: {},
};

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "next-question":
      return { ...state, currentQuestionIndex: state.currentQuestionIndex + 1 };

    case "prev-question":
      return {
        ...state,
        currentQuestionIndex: Math.max(0, state.currentQuestionIndex - 1),
      };

    case "set-answer": {
      const next = {
        ...state,
        answers: { ...state.answers, [action.questionText]: action.answer },
      };
      if (action.advance) {
        return { ...next, currentQuestionIndex: next.currentQuestionIndex + 1 };
      }
      return next;
    }

    case "toggle-selection": {
      const prev = state.selectedValues[action.questionText] ?? [];
      const next = prev.includes(action.value)
        ? prev.filter((v) => v !== action.value)
        : [...prev, action.value];
      return {
        ...state,
        selectedValues: { ...state.selectedValues, [action.questionText]: next },
      };
    }

    case "commit-multi-select": {
      const values = state.selectedValues[action.questionText] ?? [];
      const answer = values.join(", ");
      const next = {
        ...state,
        answers: { ...state.answers, [action.questionText]: answer },
      };
      if (action.advance) {
        return { ...next, currentQuestionIndex: next.currentQuestionIndex + 1 };
      }
      return next;
    }
  }
}

export interface MultipleChoiceState {
  currentQuestionIndex: number;
  answers: Record<string, string>;
  selectedValues: Record<string, string[]>;
  nextQuestion: () => void;
  prevQuestion: (total: number) => void;
  setAnswer: (questionText: string, answer: string, advance?: boolean) => void;
  toggleSelection: (questionText: string, value: string) => void;
  commitMultiSelect: (questionText: string, advance?: boolean) => void;
}

export function useMultipleChoiceState(): MultipleChoiceState {
  const [state, dispatch] = useReducer(reducer, INITIAL_STATE);

  const nextQuestion = useCallback(() => dispatch({ type: "next-question" }), []);

  const prevQuestion = useCallback(
    (total: number) => dispatch({ type: "prev-question", total }),
    [],
  );

  const setAnswer = useCallback(
    (questionText: string, answer: string, advance = true) =>
      dispatch({ type: "set-answer", questionText, answer, advance }),
    [],
  );

  const toggleSelection = useCallback(
    (questionText: string, value: string) =>
      dispatch({ type: "toggle-selection", questionText, value }),
    [],
  );

  const commitMultiSelect = useCallback(
    (questionText: string, advance = true) =>
      dispatch({ type: "commit-multi-select", questionText, advance }),
    [],
  );

  return {
    currentQuestionIndex: state.currentQuestionIndex,
    answers: state.answers,
    selectedValues: state.selectedValues,
    nextQuestion,
    prevQuestion,
    setAnswer,
    toggleSelection,
    commitMultiSelect,
  };
}
