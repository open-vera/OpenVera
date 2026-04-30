import type { AccumulatedCost } from "../../../session/index.js";
import type { Message, Usage } from "../../../types/index.js";

export interface TurnPersistenceStore {
  writeAssistant(p: {
    parentUuid: string;
    content: string;
    model: string;
    provider: string;
    stopReason: "end_turn";
    usage: Usage;
    turn: number;
    latencyMs: number;
    toolCalls: string[];
    status: "ok" | "error";
  }): string;
  writeEnd(totalUsage: Usage, totalCostUsd: number, turnCount: number, lastPrompt?: string): void;
}

export interface PersistAssistantTurnOptions {
  store: TurnPersistenceStore;
  parentUuid: string;
  content: string;
  model: string;
  provider: string;
  usage: Usage;
  turnCount: number;
  turnStartMs: number;
  toolCalls: string[];
  status: "ok" | "error";
  now?: () => number;
}

export function persistAssistantTurn(options: PersistAssistantTurnOptions): string {
  const now = options.now ?? Date.now;
  return options.store.writeAssistant({
    parentUuid: options.parentUuid,
    content: options.content,
    model: options.model,
    provider: options.provider,
    stopReason: "end_turn",
    usage: options.usage,
    turn: options.turnCount + 1,
    latencyMs: Math.max(0, now() - options.turnStartMs),
    toolCalls: options.toolCalls,
    status: options.status,
  });
}

export function appendCompletedTurnHistory(history: Message[], userPrompt: string, assistantText: string): Message[] {
  return [
    ...history,
    { role: "user", content: userPrompt },
    { role: "assistant", content: assistantText },
  ];
}

export function persistTurnEnd(
  store: TurnPersistenceStore,
  cost: AccumulatedCost,
  turnCount: number,
  lastPrompt?: string,
): void {
  store.writeEnd(cost.totalUsage, cost.totalUsd, turnCount, lastPrompt);
}
