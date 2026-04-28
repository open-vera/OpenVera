import type { Tool } from "../types/tool.js";

export const ASK_USER_QUESTION_TOOL_NAME = "AskUserQuestion";

export interface QuestionOption {
  label: string;
  description?: string;
  preview?: string;
}

export interface Question {
  question: string;
  /** Short label shown in the navigation tab bar */
  header?: string;
  /** 2–4 options */
  options: QuestionOption[];
  /** When true, user can select multiple options */
  multiSelect?: boolean;
}

export type QuestionAnswers = Record<string, string>;

export interface AskUserQuestionArgs {
  questions: Question[];
  annotations?: Record<string, { notes?: string; preview?: string }>;
  metadata?: { source?: string };
}

export function buildAskUserQuestionSchema(): Tool {
  return {
    name: ASK_USER_QUESTION_TOOL_NAME,
    description: [
      "Ask the user one or more multiple-choice questions.",
      "Each question has 2–4 options. Use multiSelect:true when choices are not mutually exclusive.",
      "When options have a 'preview' field, a side-by-side preview layout is shown.",
      "Returns the user's answers keyed by question text.",
      "Multi-select answers are comma-separated.",
    ].join(" "),
    parameters: {
      type: "object",
      properties: {
        questions: {
          type: "array",
          description: "Questions to ask (1–4). Question texts must be unique.",
          items: {
            type: "object",
            required: ["question", "options"],
            properties: {
              question: {
                type: "string",
                description: "Full question text. Should end with '?'.",
              },
              header: {
                type: "string",
                description: "Short label for the tab bar (≤12 chars).",
              },
              options: {
                type: "array",
                description: "Available choices (2–4). Labels must be unique within the question.",
                items: {
                  type: "object",
                  required: ["label"],
                  properties: {
                    label: { type: "string" },
                    description: { type: "string" },
                    preview: {
                      type: "string",
                      description: "Markdown preview rendered on the right side when this option is focused.",
                    },
                  },
                },
              },
              multiSelect: {
                type: "boolean",
                description: "Allow selecting multiple options. Defaults to false.",
              },
            },
          },
        },
        annotations: {
          type: "object",
          description: "Optional per-question annotations keyed by question text.",
        },
        metadata: {
          type: "object",
          properties: {
            source: { type: "string" },
          },
        },
      },
      required: ["questions"],
    },
  };
}
