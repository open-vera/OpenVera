import { REPL_COMMANDS } from "../../commands/metadata.js";

export interface CommandSuggestion {
  name: string;
  description: string;
}

export const COMMANDS: CommandSuggestion[] = REPL_COMMANDS.map(({ name, description }) => ({ name, description }));

export interface ComposerTextState {
  value: string;
  cursor: number;
}

export interface ComposerHistoryState extends ComposerTextState {
  historyIndex: number;
  savedDraft: string;
}

export interface ComposerHistoryResult extends ComposerHistoryState {
  changed: boolean;
}

export interface ComposerState extends ComposerHistoryState {
  selectedSuggestionIndex: number;
}

export interface ComposerKeyState {
  upArrow?: boolean;
  downArrow?: boolean;
  leftArrow?: boolean;
  rightArrow?: boolean;
  pageDown?: boolean;
  pageUp?: boolean;
  return?: boolean;
  escape?: boolean;
  ctrl?: boolean;
  shift?: boolean;
  tab?: boolean;
  backspace?: boolean;
  delete?: boolean;
  meta?: boolean;
}

export type ComposerEffect =
  | { type: "exit" }
  | { type: "cancel" }
  | { type: "submit"; line: string }
  | { type: "scroll.up" }
  | { type: "scroll.down" }
  | { type: "toggleToolOutput" };

export interface ComposerInputResult {
  state: ComposerState;
  effect?: ComposerEffect;
}

export function emptyComposerState(value = ""): ComposerState {
  return {
    value,
    cursor: value.length,
    historyIndex: -1,
    savedDraft: "",
    selectedSuggestionIndex: 0,
  };
}

export function syncComposerValue(state: ComposerState, value: string): ComposerState {
  if (state.value === value) return state;
  return normalizeComposerState({
    ...state,
    value,
    cursor: value === "" ? 0 : Math.min(state.cursor, value.length),
    historyIndex: value === "" ? -1 : state.historyIndex,
  }, state);
}

// Split string into grapheme clusters (handles emoji, CJK, combining chars).
export function getGraphemes(str: string): string[] {
  if (typeof Intl !== "undefined" && Intl.Segmenter) {
    return [...new Intl.Segmenter().segment(str)].map((s) => s.segment);
  }
  return [...str];
}

export function moveCursorByGrapheme(str: string, pos: number, dir: 1 | -1): number {
  const graphemes = getGraphemes(str);
  let offset = 0;
  const positions: number[] = [0];
  for (const g of graphemes) {
    offset += g.length;
    positions.push(offset);
  }
  const idx = positions.indexOf(pos);
  if (idx === -1) return pos;
  const next = idx + dir;
  if (next < 0 || next >= positions.length) return pos;
  return positions[next] as number;
}

export function moveWordBack(str: string, pos: number): number {
  let p = pos;
  while (p > 0 && str[p - 1] === " ") p--;
  while (p > 0 && str[p - 1] !== " ") p--;
  return p;
}

export function moveWordForward(str: string, pos: number): number {
  let p = pos;
  while (p < str.length && str[p] !== " ") p++;
  while (p < str.length && str[p] === " ") p++;
  return p;
}

export function getCommandSuggestions(value: string): CommandSuggestion[] {
  if (!value.startsWith("/") || value.includes(" ")) return [];
  const partial = value.slice(1).toLowerCase();
  return partial === ""
    ? COMMANDS
    : COMMANDS.filter((command) => command.name.startsWith(partial));
}

export interface PathCompletion {
  token: string;
  replacement: string;
  suggestions: string[];
}

export function getCurrentToken(value: string, cursor: number): { token: string; start: number; end: number } {
  const before = value.slice(0, cursor);
  const start = Math.max(before.lastIndexOf(" "), before.lastIndexOf("\n")) + 1;
  const after = value.slice(cursor);
  const nextSpace = after.search(/[\s\n]/);
  const end = nextSpace === -1 ? value.length : cursor + nextSpace;
  return { token: value.slice(start, end), start, end };
}

export function getPathCompletions(
  value: string,
  cursor: number,
  candidates: string[],
): PathCompletion | null {
  const { token, start, end } = getCurrentToken(value, cursor);
  if (!token || !(token.startsWith("./") || token.startsWith("../") || token.startsWith("/") || token.includes("/"))) {
    return null;
  }
  const suggestions = candidates
    .filter((candidate) => candidate.startsWith(token))
    .sort();
  if (suggestions.length === 0) return null;
  const replacement = suggestions.length === 1 ? suggestions[0]! : longestCommonPrefix(suggestions);
  return {
    token,
    replacement,
    suggestions,
  };
}

export function applyPathCompletion(state: ComposerTextState, completion: PathCompletion): ComposerTextState {
  const token = getCurrentToken(state.value, state.cursor);
  const value = state.value.slice(0, token.start) + completion.replacement + state.value.slice(token.end);
  return {
    value,
    cursor: token.start + completion.replacement.length,
  };
}

function longestCommonPrefix(values: string[]): string {
  if (values.length === 0) return "";
  let prefix = values[0]!;
  for (const value of values.slice(1)) {
    while (!value.startsWith(prefix) && prefix.length > 0) {
      prefix = prefix.slice(0, -1);
    }
  }
  return prefix;
}

function suggestionLength(value: string): number {
  return getCommandSuggestions(value).length;
}

function normalizeComposerState(next: ComposerState, previous: ComposerState): ComposerState {
  const previousSuggestionLength = suggestionLength(previous.value);
  const nextSuggestionLength = suggestionLength(next.value);
  const selectedSuggestionIndex = previousSuggestionLength === nextSuggestionLength
    ? Math.min(next.selectedSuggestionIndex, Math.max(0, nextSuggestionLength - 1))
    : 0;
  return { ...next, selectedSuggestionIndex };
}

function withTextState(previous: ComposerState, text: ComposerTextState): ComposerState {
  return normalizeComposerState({ ...previous, ...text }, previous);
}

function completeSelectedSuggestion(state: ComposerState): ComposerState {
  const suggestions = getCommandSuggestions(state.value);
  const chosen = suggestions[state.selectedSuggestionIndex] ?? suggestions[0];
  if (!chosen) return state;
  const value = `/${chosen.name} `;
  return {
    ...state,
    value,
    cursor: value.length,
    selectedSuggestionIndex: 0,
  };
}

export function insertAtCursor(state: ComposerTextState, text: string): ComposerTextState {
  return {
    value: state.value.slice(0, state.cursor) + text + state.value.slice(state.cursor),
    cursor: state.cursor + text.length,
  };
}

export function deleteBackAtCursor(state: ComposerTextState): ComposerTextState {
  if (state.cursor === 0) return state;
  const nextCursor = moveCursorByGrapheme(state.value, state.cursor, -1);
  return {
    value: state.value.slice(0, nextCursor) + state.value.slice(state.cursor),
    cursor: nextCursor,
  };
}

export function deleteWordBackAtCursor(state: ComposerTextState): ComposerTextState {
  const nextCursor = moveWordBack(state.value, state.cursor);
  return {
    value: state.value.slice(0, nextCursor) + state.value.slice(state.cursor),
    cursor: nextCursor,
  };
}

export function navigateComposerHistory(
  state: ComposerHistoryState,
  history: string[],
  direction: "up" | "down",
): ComposerHistoryResult {
  if (history.length === 0) return { ...state, changed: false };

  if (direction === "up") {
    const savedDraft = state.historyIndex === -1 ? state.value : state.savedDraft;
    const next = state.historyIndex === -1
      ? history.length - 1
      : Math.max(state.historyIndex - 1, 0);
    if (next === state.historyIndex) return { ...state, savedDraft, changed: false };
    const value = history[next] as string;
    return { value, cursor: value.length, historyIndex: next, savedDraft, changed: true };
  }

  if (state.historyIndex === -1) return { ...state, changed: false };
  if (state.historyIndex >= history.length - 1) {
    return {
      value: state.savedDraft,
      cursor: state.savedDraft.length,
      historyIndex: -1,
      savedDraft: state.savedDraft,
      changed: true,
    };
  }

  const next = state.historyIndex + 1;
  const value = history[next] as string;
  return {
    value,
    cursor: value.length,
    historyIndex: next,
    savedDraft: state.savedDraft,
    changed: true,
  };
}

export function reduceComposerInput(
  state: ComposerState,
  input: string,
  key: ComposerKeyState,
  history: string[],
): ComposerInputResult {
  const suggestions = getCommandSuggestions(state.value);

  if (key.ctrl && input === "c") {
    if (state.value.length > 0) {
      return {
        state: normalizeComposerState({
          ...state,
          value: "",
          cursor: 0,
          historyIndex: -1,
        }, state),
      };
    }
    return { state, effect: { type: "exit" } };
  }

  if (key.escape) {
    if (suggestions.length > 0) {
      return {
        state: normalizeComposerState({
          ...state,
          value: "",
          cursor: 0,
        }, state),
      };
    }
    return { state, effect: { type: "cancel" } };
  }

  if (key.return) {
    if (key.shift || key.meta) {
      return { state: withTextState(state, insertAtCursor(state, "\n")) };
    }
    if (suggestions.length > 0) {
      return { state: completeSelectedSuggestion(state) };
    }
    const line = state.value.trim();
    const nextState = normalizeComposerState({
      ...state,
      value: "",
      cursor: 0,
      historyIndex: -1,
    }, state);
    return line ? { state: nextState, effect: { type: "submit", line } } : { state: nextState };
  }

  if (key.tab) {
    return { state: completeSelectedSuggestion(state) };
  }

  if (key.backspace || key.delete) {
    return { state: withTextState(state, deleteBackAtCursor(state)) };
  }

  if (key.pageUp) return { state, effect: { type: "scroll.up" } };
  if (key.pageDown) return { state, effect: { type: "scroll.down" } };

  if (key.upArrow) {
    if (suggestions.length > 0) {
      return {
        state: {
          ...state,
          selectedSuggestionIndex: Math.max(0, state.selectedSuggestionIndex - 1),
        },
      };
    }
    const next = navigateComposerHistory(state, history, "up");
    return { state: next.changed ? { ...next, selectedSuggestionIndex: state.selectedSuggestionIndex } : state };
  }

  if (key.downArrow) {
    if (suggestions.length > 0) {
      return {
        state: {
          ...state,
          selectedSuggestionIndex: Math.min(suggestions.length - 1, state.selectedSuggestionIndex + 1),
        },
      };
    }
    const next = navigateComposerHistory(state, history, "down");
    return { state: next.changed ? { ...next, selectedSuggestionIndex: state.selectedSuggestionIndex } : state };
  }

  if (key.leftArrow) {
    return {
      state: {
        ...state,
        cursor: key.meta
          ? moveWordBack(state.value, state.cursor)
          : moveCursorByGrapheme(state.value, state.cursor, -1),
      },
    };
  }

  if (key.rightArrow) {
    return {
      state: {
        ...state,
        cursor: key.meta
          ? moveWordForward(state.value, state.cursor)
          : moveCursorByGrapheme(state.value, state.cursor, 1),
      },
    };
  }

  if (key.ctrl && input === "a") return { state: { ...state, cursor: 0 } };
  if (key.ctrl && input === "e") return { state: { ...state, cursor: state.value.length } };

  if ((key.meta && input.toLowerCase() === "o") || input === "ø" || input === "Ø") {
    return { state, effect: { type: "toggleToolOutput" } };
  }

  if (key.ctrl) {
    switch (input) {
      case "k":
        return { state: withTextState(state, { value: state.value.slice(0, state.cursor), cursor: state.cursor }) };
      case "u":
        return { state: withTextState(state, { value: "", cursor: 0 }) };
      case "w":
        return { state: withTextState(state, deleteWordBackAtCursor(state)) };
      case "b":
        return { state: { ...state, cursor: moveCursorByGrapheme(state.value, state.cursor, -1) } };
      case "f":
        return { state: { ...state, cursor: moveCursorByGrapheme(state.value, state.cursor, 1) } };
    }
    return { state };
  }

  if (input) {
    return { state: withTextState(state, insertAtCursor(state, input)) };
  }

  return { state };
}
