export interface ReverseSearchState {
  active: boolean;
  query: string;
  selectedIndex: number;
}

export function emptyReverseSearch(): ReverseSearchState {
  return { active: false, query: "", selectedIndex: 0 };
}

export function startReverseSearch(query = ""): ReverseSearchState {
  return { active: true, query, selectedIndex: 0 };
}

export function updateReverseSearchQuery(state: ReverseSearchState, query: string): ReverseSearchState {
  return { ...state, query, selectedIndex: 0 };
}

export function reverseSearchMatches(history: string[], query: string): string[] {
  const normalized = query.trim().toLowerCase();
  const source = [...history].reverse();
  if (!normalized) return source;
  return source.filter((item) => item.toLowerCase().includes(normalized));
}

export function moveReverseSearchSelection(
  state: ReverseSearchState,
  history: string[],
  direction: 1 | -1,
): ReverseSearchState {
  const matches = reverseSearchMatches(history, state.query);
  if (matches.length === 0) return { ...state, selectedIndex: 0 };
  const next = Math.max(0, Math.min(matches.length - 1, state.selectedIndex + direction));
  return { ...state, selectedIndex: next };
}

export function acceptReverseSearch(state: ReverseSearchState, history: string[]): string | undefined {
  return reverseSearchMatches(history, state.query)[state.selectedIndex];
}
