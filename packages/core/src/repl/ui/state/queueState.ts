export interface QueueState {
  items: string[];
}

export function emptyQueue(): QueueState {
  return { items: [] };
}

export function enqueueInput(state: QueueState, input: string): QueueState {
  const trimmed = input.trim();
  return trimmed ? { items: [...state.items, trimmed] } : state;
}

export function prependInput(state: QueueState, input: string): QueueState {
  const trimmed = input.trim();
  return trimmed ? { items: [trimmed, ...state.items] } : state;
}

export function dequeueInput(state: QueueState): { state: QueueState; next?: string } {
  const [next, ...rest] = state.items;
  return { state: { items: rest }, ...(next ? { next } : {}) };
}

export function updateQueuedInput(state: QueueState, index: number, input: string): QueueState {
  if (index < 0 || index >= state.items.length) return state;
  const trimmed = input.trim();
  if (!trimmed) return removeQueuedInput(state, index);
  return {
    items: state.items.map((item, i) => (i === index ? trimmed : item)),
  };
}

export function removeQueuedInput(state: QueueState, index: number): QueueState {
  if (index < 0 || index >= state.items.length) return state;
  return { items: state.items.filter((_, i) => i !== index) };
}
