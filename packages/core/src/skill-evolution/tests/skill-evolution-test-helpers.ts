/**
 * Shared helpers for skill-evolution test modules.
 */
import { vi } from "vitest";
import type { Message } from "../../types/index.js";
import type { LLMAdapter } from "../../adapters/base.js";

export function makeMessages(count: number): Message[] {
  const msgs: Message[] = [];
  for (let i = 0; i < count; i++) {
    msgs.push({ role: "user", content: `User message ${i}` });
    msgs.push({ role: "assistant", content: `Assistant response ${i}` });
  }
  return msgs;
}

export function mockAdapter(response: string): LLMAdapter {
  return {
    complete: vi.fn().mockResolvedValue({
      message: { role: "assistant", content: response },
      stop_reason: "end_turn",
    }),
  } as unknown as LLMAdapter;
}

/** Mock adapter that returns a specific raw response object */
export function mockAdapterRaw(rawResponse: unknown): LLMAdapter {
  return {
    complete: vi.fn().mockResolvedValue(rawResponse),
  } as unknown as LLMAdapter;
}
