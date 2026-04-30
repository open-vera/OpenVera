import { describe, expect, it } from "vitest";
import {
  ROUTING_FAILED_MESSAGE,
  appendPlanPlaceholder,
  appendRoutingFailedMessage,
  reducePlanRuntimeError,
  summarizePlanSteps,
} from "../src/repl/ui/controller/turnLifecycle.js";
import type { ChatMessage } from "../src/repl/ui/types.js";

describe("turnLifecycle", () => {
  it("appends routing failure message only when needed", () => {
    const messages: ChatMessage[] = [{ role: "user", content: "hi" }];

    expect(appendRoutingFailedMessage(messages, false)).toBe(messages);
    expect(appendRoutingFailedMessage(messages, true)).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: ROUTING_FAILED_MESSAGE },
    ]);
  });

  it("appends plan placeholder with optional routing failure prefix", () => {
    expect(appendPlanPlaceholder([], true)).toEqual([
      { role: "assistant", content: ROUTING_FAILED_MESSAGE },
      {
        role: "assistant",
        content: "",
        streaming: true,
        planMode: true,
        planSteps: [],
        activeStepIndex: -1,
      },
    ]);
  });

  it("summarizes plan steps for persistence", () => {
    expect(summarizePlanSteps([
      { id: "a", description: "Read files", status: "done", content: "Looked around", toolUses: [] },
      { id: "b", description: "Patch code", status: "done", content: "Updated files", toolUses: [] },
    ])).toBe("步骤 1：Read files\nLooked around\n\n步骤 2：Patch code\nUpdated files");
  });

  it("reduces plan runtime errors and aborts", () => {
    const messages: ChatMessage[] = [
      { role: "assistant", content: "", streaming: true, planMode: true, planSteps: [], activeStepIndex: 0 },
    ];

    expect(reducePlanRuntimeError(messages, "failed", false)).toEqual([
      { role: "assistant", content: "failed", streaming: false, planMode: false, planSteps: [], activeStepIndex: 0 },
    ]);
    expect(reducePlanRuntimeError(messages, "Cancelled.", true)).toEqual([
      { role: "assistant", content: "", streaming: false, planMode: true, planSteps: [], activeStepIndex: 0 },
    ]);
    expect(reducePlanRuntimeError([{ role: "assistant", content: "plain" }], "failed", false)).toEqual([
      { role: "assistant", content: "plain" },
    ]);
  });
});
