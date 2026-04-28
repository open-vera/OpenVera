import { Box, Text, useInput, useStdin } from "ink";
import type { Key } from "ink";
import { useState, useRef, useMemo, useEffect, useCallback, useLayoutEffect } from "react";
import { theme } from "./theme.js";
import stringWidth from "string-width";

// Parse a raw stdin chunk into Ink's (input, key) format.
// Mirrors the logic in ink/build/hooks/use-input.js + parse-keypress.js.
const NON_ALPHANUMERIC = new Set([
  "up","down","left","right","pageup","pagedown","home","end",
  "insert","delete","backspace","return","enter","tab","escape","space",
  "f1","f2","f3","f4","f5","f6","f7","f8","f9","f10","f11","f12","clear",
]);
const ANSI_ARROW: Record<string, keyof Key> = {
  "\x1b[A": "upArrow", "\x1b[B": "downArrow",
  "\x1b[C": "rightArrow", "\x1b[D": "leftArrow",
  "\x1bOA": "upArrow",   "\x1bOB": "downArrow",
  "\x1bOC": "rightArrow","\x1bOD": "leftArrow",
};
const ANSI_PAGE: Record<string, "pageUp" | "pageDown"> = {
  "\x1b[5~": "pageUp", "\x1b[6~": "pageDown",
};
function parseChunk(s: string): { input: string; key: Key } {
  const key: Key = {
    upArrow: false, downArrow: false, leftArrow: false, rightArrow: false,
    pageDown: false, pageUp: false, return: false, escape: false,
    ctrl: false, shift: false, tab: false, backspace: false, delete: false, meta: false,
  };
  if (s === "\r")                    { key.return = true;    return { input: "", key }; }
  if (s === "\t")                    { key.tab = true;       return { input: "", key }; }
  if (s === "\x7f" || s === "\x1b\x7f") { key.delete = true; key.meta = s.length > 1; return { input: "", key }; }
  if (s === "\b" || s === "\x1b\b")  { key.backspace = true; key.meta = s.length > 1; return { input: "", key }; }
  if (s === "\x1b" || s === "\x1b\x1b") { key.escape = true; key.meta = s.length > 1; return { input: "", key }; }
  // PageUp / PageDown
  const pageKey = ANSI_PAGE[s];
  if (pageKey) { (key as Record<string, boolean>)[pageKey] = true; return { input: "", key }; }
  // ANSI arrows (with optional meta prefix \x1b\x1b)
  const arrowKey = ANSI_ARROW[s] ?? ANSI_ARROW[s.replace(/^\x1b\x1b/, "\x1b")];
  if (arrowKey) {
    (key as Record<string, boolean>)[arrowKey] = true;
    if (s.startsWith("\x1b\x1b")) key.meta = true;
    return { input: "", key };
  }
  // ctrl+letter (\x01–\x1a, skip already-handled \t \r \b \x1b)
  if (s.length === 1 && s >= "\x01" && s <= "\x1a") {
    key.ctrl = true;
    const letter = String.fromCharCode(s.charCodeAt(0) + 96);
    return { input: letter, key };
  }
  // meta+letter  (\x1b + single char)
  if (s.length === 2 && s[0] === "\x1b" && s[1]! >= " ") {
    key.meta = true;
    const ch = s[1]!;
    return { input: ch, key };
  }
  // printable: strip remaining ANSI sequences, normalise line endings
  // eslint-disable-next-line no-control-regex
  const text = s.replace(/\x1b\[[^a-zA-Z]*[a-zA-Z]/g, "").replace(/\r\n|\r/g, "\n");
  if (/[A-Z]/.test(text) && text.length === 1) key.shift = true;
  return { input: text, key };
}

const COMMANDS = [
  { name: "diff",     description: "View uncommitted changes" },
  { name: "status",   description: "Provider, model & token usage" },
  { name: "sessions", description: "List saved sessions" },
  { name: "resume",   description: "Resume a previous session" },
  { name: "title",    description: "Set session title" },
  { name: "model",    description: "List available models" },
  { name: "provider", description: "Show configured providers" },
  { name: "help",     description: "Show all commands" },
  { name: "exit",     description: "Exit" },
];

// Split string into grapheme clusters (handles emoji, CJK, combining chars)
function getGraphemes(str: string): string[] {
  if (typeof Intl !== "undefined" && Intl.Segmenter) {
    return [...new Intl.Segmenter().segment(str)].map((s) => s.segment);
  }
  return [...str];
}

function moveCursorByGrapheme(str: string, pos: number, dir: 1 | -1): number {
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

function moveWordBack(str: string, pos: number): number {
  let p = pos;
  while (p > 0 && str[p - 1] === " ") p--;
  while (p > 0 && str[p - 1] !== " ") p--;
  return p;
}

function moveWordForward(str: string, pos: number): number {
  let p = pos;
  while (p < str.length && str[p] !== " ") p++;
  while (p < str.length && str[p] === " ") p++;
  return p;
}

interface InputBarProps {
  value: string;
  onChange: (v: string) => void;
  onSubmit: (line: string) => void;
  onExit: () => void;
  onCancel?: () => void;
  isStreaming?: boolean;
  history?: string[];
  onScrollUp?: () => void;
  onScrollDown?: () => void;
  onToggleToolOutput?: () => void;
}

export function InputBar({
  value,
  onChange,
  onSubmit,
  onExit,
  onCancel,
  isStreaming,
  history = [],
  onScrollUp,
  onScrollDown,
  onToggleToolOutput,
}: InputBarProps) {
  const valueRef = useRef(value);
  valueRef.current = value;

  // ── Cursor ───────────────────────────────────────────────────────────────────
  const [cursorPos, setCursorPos] = useState(value.length);
  const cursorRef = useRef(cursorPos);
  cursorRef.current = cursorPos;

  const prevValueRef = useRef(value);
  useEffect(() => {
    if (value === "" && prevValueRef.current !== "") {
      cursorRef.current = 0;
      setCursorPos(0);
    }
    prevValueRef.current = value;
  });

  const setPos = useCallback((p: number) => {
    cursorRef.current = p;
    setCursorPos(p);
  }, []);

  // ── History ──────────────────────────────────────────────────────────────────
  const historyIdxRef = useRef(-1);
  const savedDraftRef = useRef("");

  const navHistory = useCallback((dir: "up" | "down") => {
    if (history.length === 0) return;
    const idx = historyIdxRef.current;
    if (dir === "up") {
      if (idx === -1) savedDraftRef.current = valueRef.current;
      const next = idx === -1 ? history.length - 1 : Math.max(idx - 1, 0);
      if (next === idx) return;
      historyIdxRef.current = next;
      const entry = history[next] as string;
      onChange(entry);
      setPos(entry.length);
    } else {
      if (idx === -1) return;
      if (idx >= history.length - 1) {
        historyIdxRef.current = -1;
        const draft = savedDraftRef.current;
        onChange(draft);
        setPos(draft.length);
      } else {
        const next = idx + 1;
        historyIdxRef.current = next;
        const entry = history[next] as string;
        onChange(entry);
        setPos(entry.length);
      }
    }
  }, [history, onChange, setPos]);

  // ── Command suggestions ──────────────────────────────────────────────────────
  const [selectedIdx, setSelectedIdx] = useState(0);
  const selectedIdxRef = useRef(0);
  selectedIdxRef.current = selectedIdx;

  const suggestions = useMemo(() => {
    if (!value.startsWith("/") || value.includes(" ")) return [];
    const partial = value.slice(1).toLowerCase();
    return partial === "" ? COMMANDS : COMMANDS.filter(c => c.name.startsWith(partial));
  }, [value]);

  const suggestionsRef = useRef(suggestions);
  suggestionsRef.current = suggestions;

  useEffect(() => { setSelectedIdx(0); }, [suggestions.length]);

  // ── Editing ──────────────────────────────────────────────────────────────────

  const insertAt = useCallback((text: string) => {
    const pos = cursorRef.current;
    const next = valueRef.current.slice(0, pos) + text + valueRef.current.slice(pos);
    onChange(next);
    setPos(pos + text.length);
  }, [onChange, setPos]);

  const deleteBack = useCallback(() => {
    const pos = cursorRef.current;
    if (pos === 0) return;
    const newPos = moveCursorByGrapheme(valueRef.current, pos, -1);
    onChange(valueRef.current.slice(0, newPos) + valueRef.current.slice(pos));
    setPos(newPos);
  }, [onChange, setPos]);

  // ── Stable input handler ─────────────────────────────────────────────────────
  // handlerRef is updated every render so it always reads fresh closures.
  const handlerRef = useRef<(input: string, key: Key) => void>(() => {});
  handlerRef.current = (input: string, key: Key) => {
    const sugs = suggestionsRef.current;

    // ── Ctrl+C ──
    if (key.ctrl && input === "c") {
      if (valueRef.current.length > 0) {
        onChange(""); setPos(0); historyIdxRef.current = -1;
      } else {
        onExit();
      }
      return;
    }

    // ── Escape ──
    if (key.escape) {
      if (sugs.length > 0) { onChange(""); setPos(0); }
      else onCancel?.();
      return;
    }

    // ── Enter ──
    if (key.return) {
      if (sugs.length > 0) {
        const chosen = sugs[selectedIdxRef.current] ?? sugs[0];
        if (chosen) {
          const completed = `/${chosen.name} `;
          onChange(completed); setPos(completed.length); setSelectedIdx(0);
        }
        return;
      }
      const line = valueRef.current.trim();
      onChange(""); setPos(0); historyIdxRef.current = -1;
      if (line) onSubmit(line);
      return;
    }

    // ── Tab ──
    if (key.tab) {
      const first = sugs[selectedIdxRef.current] ?? sugs[0];
      if (first) {
        const completed = `/${first.name} `;
        onChange(completed); setPos(completed.length); setSelectedIdx(0);
      }
      return;
    }

    // ── Backspace ──
    // Ink 5 maps \x7f (macOS backspace key) to key.delete, not key.backspace.
    // key.backspace is only set for \x08 (Ctrl+H). Handle both as deleteBack.
    if (key.backspace || key.delete) {
      deleteBack();
      return;
    }

    // ── Scroll (PageUp / PageDown) ──
    if (key.pageUp) { onScrollUp?.(); return; }
    if (key.pageDown) { onScrollDown?.(); return; }

    // ── Arrows ──
    if (key.upArrow) {
      if (sugs.length > 0) setSelectedIdx(i => Math.max(0, i - 1));
      else navHistory("up");
      return;
    }
    if (key.downArrow) {
      if (sugs.length > 0) setSelectedIdx(i => Math.min(sugs.length - 1, i + 1));
      else navHistory("down");
      return;
    }
    if (key.leftArrow) {
      setPos(key.meta
        ? moveWordBack(valueRef.current, cursorRef.current)
        : moveCursorByGrapheme(valueRef.current, cursorRef.current, -1));
      return;
    }
    if (key.rightArrow) {
      setPos(key.meta
        ? moveWordForward(valueRef.current, cursorRef.current)
        : moveCursorByGrapheme(valueRef.current, cursorRef.current, +1));
      return;
    }

    // ── Home / End ──
    if (key.ctrl && input === "a") { setPos(0); return; }
    if (key.ctrl && input === "e") { setPos(valueRef.current.length); return; }

    // ── Tool output expand/collapse (Option/Alt+O) ──
    if ((key.meta && input.toLowerCase() === "o") || input === "ø" || input === "Ø") {
      onToggleToolOutput?.();
      return;
    }

    // ── Ctrl shortcuts ──
    if (key.ctrl) {
      switch (input) {
        case "k": onChange(valueRef.current.slice(0, cursorRef.current)); return;
        case "u": onChange(""); setPos(0); return;
        case "w": {
          const pos = cursorRef.current;
          const newPos = moveWordBack(valueRef.current, pos);
          onChange(valueRef.current.slice(0, newPos) + valueRef.current.slice(pos));
          setPos(newPos);
          return;
        }
        case "b": setPos(moveCursorByGrapheme(valueRef.current, cursorRef.current, -1)); return;
        case "f": setPos(moveCursorByGrapheme(valueRef.current, cursorRef.current, +1)); return;
      }
      return;
    }

    // ── Printable (ASCII, CJK, emoji, pasted text) ──
    if (input) insertAt(input);
  };

  // ── Input registration ───────────────────────────────────────────────────────
  // useInput registers its listener inside useEffect (async, after paint).
  // This creates a window right after mount where the first keystroke is lost —
  // noticeable when switching to a CJK IME and typing immediately.
  //
  // Fix: also register directly on internal_eventEmitter via useLayoutEffect,
  // which fires synchronously before paint. The noopHandler keeps Ink's raw-mode
  // management active; the layoutEffect listener catches any events that arrive
  // before useInput's own effect has fired.

  // No-op stable handler — activates Ink's raw-mode management only.
  const [noopHandler] = useState<(input: string, key: Key) => void>(() => () => {});
  useInput(noopHandler);

  // Register synchronously so the very first keystroke is never missed.
  // internal_eventEmitter emits('input', rawChunk) — one string arg, not parsed (input, key).
  const { internal_eventEmitter } = useStdin();
  useLayoutEffect(() => {
    const onData = (chunk: string) => {
      const { input, key } = parseChunk(chunk);
      handlerRef.current(input, key);
    };
    internal_eventEmitter.on("input", onData);
    return () => { internal_eventEmitter.off("input", onData); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Render ───────────────────────────────────────────────────────────────────

  const before = value.slice(0, cursorPos);
  const graphemesAtCursor = cursorPos < value.length
    ? getGraphemes(value.slice(cursorPos))[0] ?? " "
    : " ";
  const after = cursorPos < value.length
    ? value.slice(cursorPos + graphemesAtCursor.length)
    : "";

  const cursorDisplay = stringWidth(graphemesAtCursor) >= 2
    ? graphemesAtCursor + " "
    : graphemesAtCursor;

  return (
    <Box flexDirection="column">
      {suggestions.length > 0 && (
        <Box flexDirection="column" paddingLeft={2}>
          {suggestions.map((s, i) => {
            const active = i === selectedIdx;
            return (
              <Box key={s.name} gap={2}>
                <Text color={active ? theme.suggestion : theme.textDim} bold={active}>
                  {active ? "▶ " : "  "}/{s.name}
                </Text>
                <Text color={active ? theme.text : theme.textDim} dimColor={!active}>
                  {s.description}
                </Text>
              </Box>
            );
          })}
          <Box paddingLeft={2}>
            <Text color={theme.textDim} dimColor>↑↓ navigate  enter select  tab complete  esc dismiss</Text>
          </Box>
        </Box>
      )}

      <Box>
        <Text color={isStreaming ? theme.brand : theme.textDim}>{">"} </Text>
        {value || cursorPos === 0 ? (
          <Text>
            {before}<Text inverse>{cursorDisplay}</Text>{after}
          </Text>
        ) : (
          <Text>
            <Text inverse> </Text>
            <Text color={theme.textDim} dimColor>  Type a message or / for commands</Text>
          </Text>
        )}
      </Box>
    </Box>
  );
}
