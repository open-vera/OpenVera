import { useCallback, useReducer, useRef, useState } from "react";
import { useReplViewModel } from "./useReplViewModel.js";
import { emptyOverlay, reduceOverlay } from "../state/overlayStore.js";
import {
  emptyQueue,
  enqueueInput,
  dequeueInput,
  prependInput,
  removeQueuedInput,
  updateQueuedInput,
  type QueueState,
} from "../state/queueState.js";
import type { BlockingPrompt } from "../state/blockingPrompt.js";

export interface QueueController {
  getState: () => QueueState;
  enqueue: (input: string) => QueueState;
  prepend: (input: string) => QueueState;
  dequeue: () => { state: QueueState; next?: string };
  updateQueued: (index: number, input: string) => QueueState;
  removeQueued: (index: number) => QueueState;
  clearQueue: () => QueueState;
}

export function createQueueController(initial: QueueState = emptyQueue()): QueueController {
  let state = initial;
  const setState = (next: QueueState) => {
    state = next;
    return state;
  };

  return {
    getState: () => state,
    enqueue: (input) => setState(enqueueInput(state, input)),
    prepend: (input) => setState(prependInput(state, input)),
    dequeue: () => {
      const next = dequeueInput(state);
      state = next.state;
      return next;
    },
    updateQueued: (index, input) => setState(updateQueuedInput(state, index, input)),
    removeQueued: (index) => setState(removeQueuedInput(state, index)),
    clearQueue: () => setState(emptyQueue()),
  };
}

export function useReplController() {
  const view = useReplViewModel();
  const [overlay, dispatchOverlay] = useReducer(reduceOverlay, undefined, emptyOverlay);
  const [queue, setQueue] = useState(() => emptyQueue());
  const queueControllerRef = useRef<QueueController | null>(null);
  if (queueControllerRef.current === null) {
    queueControllerRef.current = createQueueController(queue);
  }

  const commitQueue = useCallback((next: QueueState) => {
    setQueue(next);
    return next;
  }, []);

  const openBlockingPrompt = useCallback((prompt: BlockingPrompt | null) => {
    dispatchOverlay(prompt ? { type: "open.prompt", prompt } : { type: "close" });
  }, []);

  const enqueue = useCallback((input: string) => {
    commitQueue(queueControllerRef.current!.enqueue(input));
  }, [commitQueue]);

  const prepend = useCallback((input: string) => {
    commitQueue(queueControllerRef.current!.prepend(input));
  }, [commitQueue]);

  const dequeue = useCallback((): string | undefined => {
    const next = queueControllerRef.current!.dequeue();
    commitQueue(next.state);
    return next.next;
  }, [commitQueue]);

  const updateQueued = useCallback((index: number, input: string) => {
    commitQueue(queueControllerRef.current!.updateQueued(index, input));
  }, [commitQueue]);

  const removeQueued = useCallback((index: number) => {
    commitQueue(queueControllerRef.current!.removeQueued(index));
  }, [commitQueue]);

  const clearQueue = useCallback(() => {
    commitQueue(queueControllerRef.current!.clearQueue());
  }, [commitQueue]);

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
