import { useCallback } from "react";
import type { MutableRefObject } from "react";
import { accumulateCost } from "../../../session/index.js";
import type { AccumulatedCost } from "../../../session/index.js";
import type { Usage } from "../../../types/index.js";
import type { ChatMessage, RoutingInfo, StreamStatus, TokenUsage } from "../types.js";
import type { UiEvent } from "../events.js";

export interface StreamingHelpersProps {
  streamingBufferRef: MutableRefObject<string>;
  rafRef: MutableRefObject<ReturnType<typeof setTimeout> | null>;
  abortRef: MutableRefObject<AbortController | null>;
  costRef: MutableRefObject<AccumulatedCost>;
  latestInputTokensRef: MutableRefObject<number>;
  routing: RoutingInfo;
  inputValue: string;
  streamStatus: StreamStatus;
  rows: number;
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  setUsage: React.Dispatch<React.SetStateAction<TokenUsage>>;
  setScrollOffset: React.Dispatch<React.SetStateAction<number>>;
  setInputValue: React.Dispatch<React.SetStateAction<string>>;
  prependPendingInput?: (input: string) => void;
  onAssistantUpdate?: (text: string) => void;
  onUiEvent?: (event: UiEvent) => void;
}

export function useStreamingHelpers(props: StreamingHelpersProps) {
  const {
    streamingBufferRef, rafRef, abortRef,
    costRef, latestInputTokensRef,
    routing, inputValue, streamStatus, rows,
    setMessages, setUsage,
    setScrollOffset, setInputValue, prependPendingInput,
    onAssistantUpdate, onUiEvent,
  } = props;

  const SCROLL_STEP = Math.max(5, Math.floor((rows - 4) / 2));

  const flushBuffer = useCallback(() => {
    if (onAssistantUpdate) {
      onAssistantUpdate(streamingBufferRef.current);
      return;
    }
    setMessages((prev) => {
      const last = prev[prev.length - 1];
      if (!last?.streaming) return prev;
      return [...prev.slice(0, -1), { ...last, content: streamingBufferRef.current }];
    });
  }, [onAssistantUpdate, setMessages, streamingBufferRef]);

  const onTextDelta = useCallback((delta: string) => {
    streamingBufferRef.current += delta;
    if (rafRef.current === null) {
      rafRef.current = setTimeout(() => {
        flushBuffer();
        rafRef.current = null;
      }, 16);
    }
  }, [flushBuffer, rafRef, streamingBufferRef]);

  const onUsage = useCallback((u: Usage) => {
    const updated = accumulateCost(costRef.current, u, routing.model, routing.provider);
    costRef.current = updated;
    if (u.input_tokens) latestInputTokensRef.current = u.input_tokens;
    const event: UiEvent = {
      type: "usage.updated",
      usage: {
        inputTotal: u.input_tokens ?? 0,
        outputTotal: u.output_tokens ?? 0,
        cacheWriteTotal: u.cache_creation_input_tokens ?? 0,
        cacheReadTotal: u.cache_read_input_tokens ?? 0,
        costUsd: updated.totalUsd,
      },
      outputTokensDelta: u.output_tokens ?? 0,
    };
    if (onUiEvent) onUiEvent(event);
    else {
      setUsage((prev) => ({
        inputTotal: prev.inputTotal + event.usage.inputTotal!,
        outputTotal: prev.outputTotal + event.usage.outputTotal!,
        cacheWriteTotal: prev.cacheWriteTotal + event.usage.cacheWriteTotal!,
        cacheReadTotal: prev.cacheReadTotal + event.usage.cacheReadTotal!,
        costUsd: updated.totalUsd,
      }));
    }
  }, [costRef, latestInputTokensRef, onUiEvent, routing.model, routing.provider, setUsage]);

  const handleCancel = useCallback(() => {
    if (streamStatus !== "idle") {
      const pending = inputValue.trim();
      if (pending) {
        prependPendingInput?.(pending);
        setInputValue("");
      }
      abortRef.current?.abort();
    } else {
      if (inputValue.length > 0) setInputValue("");
    }
  }, [abortRef, inputValue, prependPendingInput, setInputValue, streamStatus]);

  const handleScrollUp = useCallback(() => {
    setScrollOffset((prev) => prev + SCROLL_STEP);
  }, [SCROLL_STEP, setScrollOffset]);

  const handleScrollDown = useCallback(() => {
    setScrollOffset((prev) => {
      const next = Math.max(0, prev - SCROLL_STEP);
      return next;
    });
  }, [SCROLL_STEP, setScrollOffset]);

  return { flushBuffer, onTextDelta, onUsage, handleCancel, handleScrollUp, handleScrollDown };
}
