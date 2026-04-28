import { Box, Text, useStdin } from "ink";
import { useState, useRef, useLayoutEffect, useCallback } from "react";
import type { Key } from "ink";
import type { SessionSummary } from "../../session/index.js";

// Minimal key parser (reuse same escape-sequence logic as InputBar)
const ANSI_ARROW: Record<string, keyof Key> = {
  "\x1b[A": "upArrow", "\x1b[B": "downArrow",
  "\x1bOA": "upArrow", "\x1bOB": "downArrow",
};
function parseKey(s: string): Key {
  const key: Key = {
    upArrow: false, downArrow: false, leftArrow: false, rightArrow: false,
    pageDown: false, pageUp: false, return: false, escape: false,
    ctrl: false, shift: false, tab: false, backspace: false, delete: false, meta: false,
  };
  if (s === "\r") { key.return = true; return key; }
  if (s === "\x1b" || s === "\x1b\x1b") { key.escape = true; return key; }
  const arrowKey = ANSI_ARROW[s];
  if (arrowKey) { (key as Record<string, boolean>)[arrowKey] = true; return key; }
  if (s.length === 1 && s >= "\x01" && s <= "\x1a") {
    key.ctrl = true;
    return key;
  }
  return key;
}

interface SessionPickerProps {
  sessions: SessionSummary[];
  onSelect: (sessionId: string) => void;
  onClose: () => void;
  width: number;
}

export function SessionPicker({ sessions, onSelect, onClose, width: _width }: SessionPickerProps) {
  const [selectedIdx, setSelectedIdx] = useState(0);
  const selectedIdxRef = useRef(0);
  selectedIdxRef.current = selectedIdx;

  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;

  const handleKey = useCallback((chunk: string) => {
    const key = parseKey(chunk);
    if (key.escape) { onClose(); return; }
    if (key.upArrow) {
      setSelectedIdx(i => Math.max(0, i - 1));
      return;
    }
    if (key.downArrow) {
      setSelectedIdx(i => Math.min(sessionsRef.current.length - 1, i + 1));
      return;
    }
    if (key.return) {
      const s = sessionsRef.current[selectedIdxRef.current];
      if (s) onSelect(s.sessionId);
      return;
    }
  }, [onClose, onSelect]);

  const { internal_eventEmitter } = useStdin();
  useLayoutEffect(() => {
    const onData = (chunk: string) => handleKey(chunk);
    internal_eventEmitter.on("input", onData);
    return () => { internal_eventEmitter.off("input", onData); };
  }, [internal_eventEmitter, handleKey]);

  if (sessions.length === 0) {
    return (
      <Box flexDirection="column" paddingLeft={2}>
        <Text color="gray">No sessions found.</Text>
        <Text color="gray" dimColor>esc to close</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingLeft={2}>
      <Text color="gray" dimColor>─── Resume session ──────────────────────────────</Text>
      {sessions.map((s, i) => {
        const active = i === selectedIdx;
        const date = s.startedAt.toISOString().slice(0, 16).replace("T", " ");
        const turns = `${s.turnCount}t`;
        const title = s.title ? `  ${s.title}` : "";
        return (
          <Box key={s.sessionId} gap={1}>
            <Text color={active ? "cyan" : "gray"} bold={active}>
              {active ? "▶" : " "}
            </Text>
            <Text color={active ? "white" : "gray"} bold={active}>
              {s.sessionId.slice(0, 8)}
            </Text>
            <Text color={active ? "white" : "gray"} dimColor={!active}>
              {date}
            </Text>
            <Text color={active ? "cyan" : "gray"} dimColor={!active}>
              {turns}
            </Text>
            <Text color={active ? "white" : "gray"} dimColor={!active} wrap="truncate-end">
              {title}
            </Text>
          </Box>
        );
      })}
      <Text color="gray" dimColor>↑↓ navigate  enter select  esc close</Text>
    </Box>
  );
}
