import type { Key } from "ink";

const ANSI_ARROW: Record<string, keyof Key> = {
  "\x1b[A": "upArrow",
  "\x1b[B": "downArrow",
  "\x1b[C": "rightArrow",
  "\x1b[D": "leftArrow",
  "\x1bOA": "upArrow",
  "\x1bOB": "downArrow",
  "\x1bOC": "rightArrow",
  "\x1bOD": "leftArrow",
};

const ANSI_PAGE: Record<string, "pageUp" | "pageDown"> = {
  "\x1b[5~": "pageUp",
  "\x1b[6~": "pageDown",
};

const FOCUS_EVENT_PATTERN = /^(?:\x1b\[(?:I|O)|\[(?:I|O))+$/;
const SGR_MOUSE_PATTERN = /^(?:\x1b)?\[<\d+;\d+;\d+[mM]$/;
const X10_MOUSE_PATTERN = /^(?:\x1b)?\[M[\s\S]{3}$/;

export function emptyKey(): Key {
  return {
    upArrow: false,
    downArrow: false,
    leftArrow: false,
    rightArrow: false,
    pageDown: false,
    pageUp: false,
    return: false,
    escape: false,
    ctrl: false,
    shift: false,
    tab: false,
    backspace: false,
    delete: false,
    meta: false,
  };
}

export function isTerminalControlInput(input: string): boolean {
  if (!input) return false;
  return (
    FOCUS_EVENT_PATTERN.test(input) ||
    SGR_MOUSE_PATTERN.test(input) ||
    X10_MOUSE_PATTERN.test(input)
  );
}

// Parse a raw stdin chunk into Ink's (input, key) format.
// Mirrors the logic in ink/build/hooks/use-input.js + parse-keypress.js.
export function parseInputChunk(s: string): { input: string; key: Key } {
  const key = emptyKey();
  if (isTerminalControlInput(s)) {
    return { input: "", key };
  }
  if (s === "\r") {
    key.return = true;
    return { input: "", key };
  }
  if (s === "\t") {
    key.tab = true;
    return { input: "", key };
  }
  if (s === "\x7f" || s === "\x1b\x7f") {
    key.delete = true;
    key.meta = s.length > 1;
    return { input: "", key };
  }
  if (s === "\b" || s === "\x1b\b") {
    key.backspace = true;
    key.meta = s.length > 1;
    return { input: "", key };
  }
  if (s === "\x1b" || s === "\x1b\x1b") {
    key.escape = true;
    key.meta = s.length > 1;
    return { input: "", key };
  }
  const pageKey = ANSI_PAGE[s];
  if (pageKey) {
    key[pageKey] = true;
    return { input: "", key };
  }
  const arrowKey = ANSI_ARROW[s] ?? ANSI_ARROW[s.replace(/^\x1b\x1b/, "\x1b")];
  if (arrowKey) {
    key[arrowKey] = true;
    if (s.startsWith("\x1b\x1b")) key.meta = true;
    return { input: "", key };
  }
  if (s.length === 1 && s >= "\x01" && s <= "\x1a") {
    key.ctrl = true;
    const letter = String.fromCharCode(s.charCodeAt(0) + 96);
    return { input: letter, key };
  }
  if (s.length === 2 && s[0] === "\x1b" && s[1]! >= " ") {
    key.meta = true;
    const ch = s[1]!;
    return { input: ch, key };
  }
  // eslint-disable-next-line no-control-regex
  const text = s.replace(/\x1b\[[^a-zA-Z]*[a-zA-Z]/g, "").replace(/\r\n|\r/g, "\n");
  if (/[A-Z]/.test(text) && text.length === 1) key.shift = true;
  return { input: text, key };
}

export function parseInputKey(s: string): Key {
  return parseInputChunk(s).key;
}
