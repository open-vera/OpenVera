import { useCallback, useReducer, useState } from "react";
import { useReplViewModel } from "./useReplViewModel.js";
import { emptyOverlay, reduceOverlay } from "../state/overlayStore.js";
import {
  emptyQueue,
  enqueueInput,
  dequeueInput,
  prependInput,
  removeQueuedInput,
  updateQueuedInput,
} from "../state/queueState.js";
import type { BlockingPrompt } from "../state/blockingPrompt.js";

export function useReplController() {
  const view = useReplViewModel();
  const [overlay, dispatchOverlay] = useReducer(reduceOverlay, undefined, emptyOverlay);
  const [queue, setQueue] = useState(() => emptyQueue());

  const openBlockingPrompt = useCallback((prompt: BlockingPrompt | null) => {
    dispatchOverlay(prompt ? { type: "open.prompt", prompt } : { type: "close" });
  }, []);

  const enqueue = useCallback((input: string) => {
    setQueue((prev) => enqueueInput(prev, input));
  }, []);

  const prepend = useCallback((input: string) => {
    setQueue((prev) => prependInput(prev, input));
  }, []);

  const dequeue = useCallback((): string | undefined => {
    let nextValue: string | undefined;
    setQueue((prev) => {
      const next = dequeueInput(prev);
      nextValue = next.next;
      return next.state;
    });
    return nextValue;
  }, []);

  const updateQueued = useCallback((index: number, input: string) => {
    setQueue((prev) => updateQueuedInput(prev, index, input));
  }, []);

  const removeQueued = useCallback((index: number) => {
    setQueue((prev) => removeQueuedInput(prev, index));
  }, []);

  const clearQueue = useCallback(() => {
    setQueue(emptyQueue());
  }, []);

  return {
    ...view,
    overlay,
    dispatchOverlay,
    openBlockingPrompt,
    queue,
    enqueue,
    prepend,
    dequeue,
    updateQueued,
    removeQueued,
    clearQueue,
  };
}
