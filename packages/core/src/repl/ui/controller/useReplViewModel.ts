import { useCallback, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { emptyReplViewModel } from "../events.js";
import type { ReplViewModel, UiEvent } from "../events.js";
import type { ChatMessage, StreamStatus, TokenUsage } from "../types.js";
import { projectUiEvent } from "./eventProjector.js";

export interface ReplViewModelController {
  viewModel: ReplViewModel;
  activeTurn: ReplViewModel["activeTurn"];
  messages: ChatMessage[];
  streamStatus: StreamStatus;
  usage: TokenUsage;
  setMessages: Dispatch<SetStateAction<ChatMessage[]>>;
  setStreamStatus: Dispatch<SetStateAction<StreamStatus>>;
  setUsage: Dispatch<SetStateAction<TokenUsage>>;
  dispatchUiEvent: (event: UiEvent) => void;
}

export function useReplViewModel(): ReplViewModelController {
  const [viewModel, setViewModel] = useState<ReplViewModel>(() => emptyReplViewModel());

  const setMessages = useCallback<Dispatch<SetStateAction<ChatMessage[]>>>((next) => {
    setViewModel((prev) => ({
      ...prev,
      messages: typeof next === "function" ? next(prev.messages) : next,
    }));
  }, []);

  const setStreamStatus = useCallback<Dispatch<SetStateAction<StreamStatus>>>((next) => {
    setViewModel((prev) => ({
      ...prev,
      status: typeof next === "function" ? next(prev.status) : next,
    }));
  }, []);

  const setUsage = useCallback<Dispatch<SetStateAction<TokenUsage>>>((next) => {
    setViewModel((prev) => ({
      ...prev,
      usage: typeof next === "function" ? next(prev.usage) : next,
    }));
  }, []);

  const dispatchUiEvent = useCallback((event: UiEvent) => {
    setViewModel((prev) => projectUiEvent(prev, event));
  }, []);

  return {
    viewModel,
    activeTurn: viewModel.activeTurn,
    messages: viewModel.messages,
    streamStatus: viewModel.status,
    usage: viewModel.usage,
    setMessages,
    setStreamStatus,
    setUsage,
    dispatchUiEvent,
  };
}
