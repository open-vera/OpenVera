import { describe, expect, it, vi } from "vitest";
import {
  appendCompletedTurnHistory,
  persistAssistantTurn,
  persistTurnEnd,
  type TurnPersistenceStore,
} from "../src/repl/ui/controller/turnPersistence.js";
import type { Message, Usage } from "../src/types/index.js";

function store(): TurnPersistenceStore & {
  writeAssistant: ReturnType<typeof vi.fn>;
  writeEnd: ReturnType<typeof vi.fn>;
} {
  return {
    writeAssistant: vi.fn(() => "assistant-uuid"),
    writeEnd: vi.fn(),
  };
}

describe("turnPersistence", () => {
  it("persists assistant turn with derived turn number and latency", () => {
    const sessionStore = store();
    const usage: Usage = { input_tokens: 1, output_tokens: 2 };

    const uuid = persistAssistantTurn({
      store: sessionStore,
      parentUuid: "user-uuid",
      content: "answer",
      model: "model",
      provider: "provider",
      usage,
      turnCount: 3,
      turnStartMs: 100,
      toolCalls: ["read_file"],
      status: "ok",
      now: () => 250,
    });

    expect(uuid).toBe("assistant-uuid");
    expect(sessionStore.writeAssistant).toHaveBeenCalledWith({
      parentUuid: "user-uuid",
      content: "answer",
      model: "model",
      provider: "provider",
      stopReason: "end_turn",
      usage,
      turn: 4,
      latencyMs: 150,
      toolCalls: ["read_file"],
      status: "ok",
    });
  });

  it("appends completed user and assistant messages to history", () => {
    const history: Message[] = [{ role: "user", content: "previous" }];

    expect(appendCompletedTurnHistory(history, "prompt", "answer")).toEqual([
      { role: "user", content: "previous" },
      { role: "user", content: "prompt" },
      { role: "assistant", content: "answer" },
    ]);
    expect(history).toEqual([{ role: "user", content: "previous" }]);
  });

  it("persists turn end from accumulated cost", () => {
    const sessionStore = store();
    persistTurnEnd(
      sessionStore,
      { totalUsage: { input_tokens: 5, output_tokens: 6 }, totalUsd: 0.25, byModel: {} },
      2,
      "last prompt",
    );

    expect(sessionStore.writeEnd).toHaveBeenCalledWith(
      { input_tokens: 5, output_tokens: 6 },
      0.25,
      2,
      "last prompt",
    );
  });
});
