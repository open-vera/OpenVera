import { Box, Text, useInput, useStdin } from "ink";
import type { Key } from "ink";
import { useState, useRef, useMemo, useEffect, useLayoutEffect } from "react";
import { theme } from "./theme.js";
import stringWidth from "string-width";
import { parseInputChunk } from "./inputKeys.js";
import {
  emptyComposerState,
  applyPathCompletion,
  getCommandSuggestions,
  getGraphemes,
  getPathCompletions,
  reduceComposerInput,
  syncComposerValue,
} from "./state/composerState.js";
import {
  acceptReverseSearch,
  emptyReverseSearch,
  moveReverseSearchSelection,
  reverseSearchMatches,
  startReverseSearch,
  updateReverseSearchQuery,
} from "./state/reverseSearch.js";
import { createExternalEditorRequest } from "./state/externalEditor.js";
import type { ExternalEditorResult } from "./state/externalEditor.js";

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
  pathCandidates?: string[];
  onOpenExternalEditor?: (request: { initialValue: string; cursor: number }) => void | Promise<ExternalEditorResult | null>;
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
  pathCandidates = [],
  onOpenExternalEditor,
}: InputBarProps) {
  const valueRef = useRef(value);
  valueRef.current = value;
  const historyRef = useRef(history);
  historyRef.current = history;

  const [composer, setComposer] = useState(() => emptyComposerState(value));
  const composerRef = useRef(composer);
  composerRef.current = composer;
  const [reverseSearch, setReverseSearch] = useState(() => emptyReverseSearch());
  const reverseSearchRef = useRef(reverseSearch);
  reverseSearchRef.current = reverseSearch;

  useEffect(() => {
    setComposer((prev) => {
      const next = syncComposerValue(prev, value);
      composerRef.current = next;
      return next;
    });
  }, [value]);

  // ── Command suggestions ──────────────────────────────────────────────────────
  const suggestions = useMemo(() => {
    return getCommandSuggestions(composer.value);
  }, [composer.value]);
  const pathCompletion = useMemo(() => {
    return getPathCompletions(composer.value, composer.cursor, pathCandidates);
  }, [composer.cursor, composer.value, pathCandidates]);

  const suggestionsRef = useRef(suggestions);
  suggestionsRef.current = suggestions;

  // ── Stable input handler ─────────────────────────────────────────────────────
  // handlerRef is updated every render so it always reads fresh closures.
  const handlerRef = useRef<(input: string, key: Key) => void>(() => {});
  handlerRef.current = (input: string, key: Key) => {
    if (reverseSearchRef.current.active) {
      if (key.escape) {
        setReverseSearch(emptyReverseSearch());
        return;
      }
      if (key.return) {
        const accepted = acceptReverseSearch(reverseSearchRef.current, historyRef.current);
        setReverseSearch(emptyReverseSearch());
        if (accepted !== undefined) {
          const next = syncComposerValue(composerRef.current, accepted);
          composerRef.current = { ...next, cursor: accepted.length };
          setComposer(composerRef.current);
          onChange(accepted);
        }
        return;
      }
      if (key.upArrow) {
        setReverseSearch((prev) => moveReverseSearchSelection(prev, historyRef.current, -1));
        return;
      }
      if (key.downArrow) {
        setReverseSearch((prev) => moveReverseSearchSelection(prev, historyRef.current, 1));
        return;
      }
      if (key.backspace || key.delete) {
        setReverseSearch((prev) => updateReverseSearchQuery(prev, prev.query.slice(0, -1)));
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        setReverseSearch((prev) => updateReverseSearchQuery(prev, prev.query + input));
        return;
      }
      return;
    }

    if (key.ctrl && input === "r") {
      setReverseSearch(startReverseSearch());
      return;
    }

    if (key.ctrl && input === "x") {
      const result = onOpenExternalEditor?.(createExternalEditorRequest(composerRef.current.value, composerRef.current.cursor));
      if (result && typeof result.then === "function") {
        void result.then((editorResult) => {
          if (!editorResult) return;
          const next = syncComposerValue(composerRef.current, editorResult.value);
          composerRef.current = { ...next, cursor: editorResult.cursor };
          setComposer(composerRef.current);
          onChange(editorResult.value);
        });
      }
      return;
    }

    if (key.tab && pathCompletion && suggestions.length === 0) {
      const nextText = applyPathCompletion(composerRef.current, pathCompletion);
      const next = syncComposerValue(composerRef.current, nextText.value);
      composerRef.current = { ...next, cursor: nextText.cursor };
      setComposer(composerRef.current);
      onChange(nextText.value);
      return;
    }

    const result = reduceComposerInput(composerRef.current, input, key, historyRef.current);
    composerRef.current = result.state;
    setComposer(result.state);
    if (result.state.value !== valueRef.current) onChange(result.state.value);

    switch (result.effect?.type) {
      case "exit":
        onExit();
        break;
      case "cancel":
        onCancel?.();
        break;
      case "submit":
        onSubmit(result.effect.line);
        break;
      case "scroll.up":
        onScrollUp?.();
        break;
      case "scroll.down":
        onScrollDown?.();
        break;
      case "toggleToolOutput":
        onToggleToolOutput?.();
        break;
    }
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
      const { input, key } = parseInputChunk(chunk);
      handlerRef.current(input, key);
    };
    internal_eventEmitter.on("input", onData);
    return () => { internal_eventEmitter.off("input", onData); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Render ───────────────────────────────────────────────────────────────────

  const displayValue = composer.value.replace(/\n/g, "⏎ ");
  const displayCursor = composer.value.slice(0, composer.cursor).replace(/\n/g, "⏎ ").length;
  const before = displayValue.slice(0, displayCursor);
  const graphemesAtCursor = displayCursor < displayValue.length
    ? getGraphemes(displayValue.slice(displayCursor))[0] ?? " "
    : " ";
  const after = displayCursor < displayValue.length
    ? displayValue.slice(displayCursor + graphemesAtCursor.length)
    : "";

  const cursorDisplay = stringWidth(graphemesAtCursor) >= 2
    ? graphemesAtCursor + " "
    : graphemesAtCursor;

  return (
    <Box flexDirection="column">
      {reverseSearch.active && (
        <Box flexDirection="column" paddingLeft={2}>
          <Text color={theme.suggestion}>reverse-search: {reverseSearch.query || " "}</Text>
          {reverseSearchMatches(history, reverseSearch.query).slice(0, 5).map((match, i) => (
            <Text key={`${match}-${i}`} color={i === reverseSearch.selectedIndex ? theme.text : theme.textDim} bold={i === reverseSearch.selectedIndex} wrap="truncate-end">
              {i === reverseSearch.selectedIndex ? "▶ " : "  "}{match}
            </Text>
          ))}
          <Text color={theme.textDim} dimColor>↑↓ navigate  enter accept  esc dismiss</Text>
        </Box>
      )}
      {suggestions.length > 0 && (
        <Box flexDirection="column" paddingLeft={2}>
          {suggestions.map((s, i) => {
            const active = i === composer.selectedSuggestionIndex;
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
      {suggestions.length === 0 && pathCompletion && (
        <Box flexDirection="column" paddingLeft={2}>
          {pathCompletion.suggestions.slice(0, 6).map((suggestion, i) => (
            <Text key={`${suggestion}-${i}`} color={i === 0 ? theme.suggestion : theme.textDim} bold={i === 0} wrap="truncate-end">
              {i === 0 ? "▶ " : "  "}{suggestion}
            </Text>
          ))}
          <Text color={theme.textDim} dimColor>tab complete path</Text>
        </Box>
      )}

      <Box>
        <Text color={isStreaming ? theme.brand : theme.textDim}>{">"} </Text>
        {composer.value || composer.cursor === 0 ? (
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
