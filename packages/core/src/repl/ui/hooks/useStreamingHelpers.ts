import { useCallback } from "react";
import type { MutableRefObject } from "react";
import { accumulateCost } from "../../../session/index.js";
import type { AccumulatedCost } from "../../../session/index.js";
import type { Usage } from "../../../types/index.js";
import type { ChatMessage, RoutingInfo, StreamStatus, TokenUsage } from "../types.js";

export interface StreamingHelpersProps {
  streamingBufferRef: MutableRefObject<string>;
  rafRef: MutableRefObject<ReturnType<typeof setTimeout> | null>;
  abortRef: MutableRefObject<AbortController | null>;
  costRef: MutableRefObject<AccumulatedCost>;
  latestInputTokensRef: MutableRefObject<number>;
  pendingQueueRef: MutableRefObject<string[]>;
  routing: RoutingInfo;
  inputValue: string;
  streamStatus: StreamStatus;
  rows: number;
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  setUsage: React.Dispatch<React.SetStateAction<TokenUsage>>;
  setCurrentOutputTokens: React.Dispatch<React.SetStateAction<number>>;
  setScrollOffset: React.Dispatch<React.SetStateAction<number>>;
  setInputValue: React.Dispatch<React.SetStateAction<string>>;
  syncQueue: () => void;
}

export function useStreamingHelpers(props: StreamingHelpersProps) {
  const {
    streamingBufferRef, rafRef, abortRef,
    costRef, latestInputTokensRef, pendingQueueRef,
    routing, inputValue, streamStatus, rows,
    setMessages, setUsage, setCurrentOutputTokens,
    setScrollOffset, setInputValue, syncQueue,
  } = props;

  const SCROLL_STEP = Math.max(5, Math.floor((rows - 4) / 2));

  const flushBuffer = useCallback(() => {
    setMessages((prev) => {
      const last = prev[prev.length - 1];
      if (!last?.streaming) return prev;
      return [...prev.slice(0, -1), { ...last, content: streamingBufferRef.current }];
    });
  }, [setMessages, streamingBufferRef]);

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
    setUsage((prev) => ({
      inputTotal: prev.inputTotal + (u.input_tokens ?? 0),
      outputTotal: prev.outputTotal + (u.output_tokens ?? 0),
      cacheWriteTotal: prev.cacheWriteTotal + (u.cache_creation_input_tokens ?? 0),
      cacheReadTotal: prev.cacheReadTotal + (u.cache_read_input_tokens ?? 0),
      costUsd: updated.totalUsd,
    }));
    setCurrentOutputTokens((prev) => prev + (u.output_tokens ?? 0));
  }, [costRef, latestInputTokensRef, routing.model, routing.provider, setCurrentOutputTokens, setUsage]);

  const handleCancel = useCallback(() => {
    if (streamStatus !== "idle") {
      const pending = inputValue.trim();
      if (pending) {
        pendingQueueRef.current.unshift(pending);
        syncQueue();
        setInputValue("");
      }
      abortRef.current?.abort();
    } else {
      if (inputValue.length > 0) setInputValue("");
    }
  }, [abortRef, inputValue, pendingQueueRef, setInputValue, streamStatus, syncQueue]);

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
