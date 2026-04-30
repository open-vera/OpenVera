import type { Usage } from "../../../types/index.js";

export function emptyTurnUsage(): Usage {
  return { input_tokens: 0, output_tokens: 0 };
}

export function accumulateTurnUsage(current: Usage, next: Usage): Usage {
  return {
    input_tokens: current.input_tokens + next.input_tokens,
    output_tokens: current.output_tokens + next.output_tokens,
    cache_creation_input_tokens: (current.cache_creation_input_tokens ?? 0) + (next.cache_creation_input_tokens ?? 0),
    cache_read_input_tokens: (current.cache_read_input_tokens ?? 0) + (next.cache_read_input_tokens ?? 0),
  };
}
