import { describe, expect, it, vi } from "vitest";
import { pathApprovalPrompt, questionPrompt } from "../src/repl/ui/state/blockingPrompt.js";

describe("blockingPrompt", () => {
  it("creates a reusable approval prompt spec", () => {
    const resolve = vi.fn();
    const prompt = pathApprovalPrompt({
      message: "Allow file access?",
      allowDir: "/tmp/project",
      resolve,
    });

    expect(prompt).toEqual({
      kind: "approval",
      message: "Allow file access?",
      options: [
        { value: true, label: "Allow", description: "/tmp/project" },
        { value: false, label: "Deny" },
      ],
      resolve,
    });
  });

  it("creates a reusable question prompt spec", () => {
    const resolve = vi.fn();
    const questions = [{ question: "Pick one", options: [{ label: "A", value: "a" }] }];

    expect(questionPrompt({ questions, resolve })).toEqual({
      kind: "question",
      questions,
      resolve,
    });
  });
});
