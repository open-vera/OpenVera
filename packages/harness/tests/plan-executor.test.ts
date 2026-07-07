import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LLMAdapter } from "@open-vera/core/adapters";
import type { PlanEvent } from "@open-vera/core/plan";
import type { ToolResult } from "@open-vera/core/tools";

const streamAgentMock = vi.fn();
const planFromPromptMock = vi.fn();
const critiqueStepMock = vi.fn();

vi.mock("@open-vera/core/agent", () => ({
  streamAgent: (...args: unknown[]) => streamAgentMock(...args),
}));

vi.mock("../src/runtime/planner.js", () => ({
  planFromPrompt: (...args: unknown[]) => planFromPromptMock(...args),
}));

vi.mock("../src/runtime/critique.js", () => ({
  critiqueStep: (...args: unknown[]) => critiqueStepMock(...args),
}));

const adapter = {} as LLMAdapter;
const toolResult: ToolResult = { ok: true, content: "ok" };

function step(id: string, action: string) {
  return { id, action, type: "execute", status: "pending" };
}

describe("createHarnessPlanExecutor", () => {
  beforeEach(() => {
    streamAgentMock.mockReset();
    planFromPromptMock.mockReset();
    critiqueStepMock.mockReset();
  });

  it("caps interactive replanning to prevent ever-growing confirmation steps", async () => {
    const { createHarnessPlanExecutor } = await import("../src/runtime/plan-executor.js");
    planFromPromptMock
      .mockResolvedValueOnce({ steps: [step("a", "first"), step("b", "second")] })
      .mockResolvedValueOnce({ steps: [step("r1", "replanned"), step("r2", "finish")] });
    streamAgentMock.mockResolvedValue("done");
    critiqueStepMock
      .mockResolvedValueOnce({ critique: { nextAction: "replan" } })
      .mockResolvedValueOnce({ critique: { nextAction: "replan" } })
      .mockResolvedValue({ critique: { nextAction: "complete" } });
    const events: PlanEvent[] = [];

    await createHarnessPlanExecutor(adapter, "model")(
      "goal",
      {
        adapter,
        model: "model",
        tools: [],
        system: "system",
        signal: new AbortController().signal,
        onToolCall: vi.fn(async () => toolResult),
      },
      (event) => events.push(event),
      vi.fn(),
    );

    expect(planFromPromptMock).toHaveBeenCalledTimes(2);
    expect(events.filter((event) => event.type === "plan_ready")).toHaveLength(2);
    expect(events.at(-1)).toEqual({ type: "plan_done" });
  });
});
