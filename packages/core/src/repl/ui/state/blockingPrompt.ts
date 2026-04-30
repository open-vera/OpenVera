import type {
  AskUserQuestionArgs,
  QuestionAnswers,
} from "../../../tools/ask-user-question.js";

export interface ApprovalOption {
  value: boolean;
  label: string;
  description?: string;
}

export type BlockingPrompt =
  | {
      kind: "approval";
      message: string;
      options: ApprovalOption[];
      resolve: (approved: boolean) => void;
    }
  | {
      kind: "question";
      questions: AskUserQuestionArgs["questions"];
      resolve: (answers: QuestionAnswers) => void;
    };

export function pathApprovalPrompt(options: {
  message: string;
  allowDir: string;
  resolve: (approved: boolean) => void;
}): BlockingPrompt {
  return {
    kind: "approval",
    message: options.message,
    options: [
      { value: true, label: "Allow", description: options.allowDir },
      { value: false, label: "Deny" },
    ],
    resolve: options.resolve,
  };
}

export function questionPrompt(options: {
  questions: AskUserQuestionArgs["questions"];
  resolve: (answers: QuestionAnswers) => void;
}): BlockingPrompt {
  return {
    kind: "question",
    questions: options.questions,
    resolve: options.resolve,
  };
}
