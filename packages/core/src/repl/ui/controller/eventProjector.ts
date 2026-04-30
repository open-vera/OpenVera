import type { ChatMessage } from "../types.js";
import type { ReplViewModel, UiEvent } from "../events.js";
import { reduceActiveTurn } from "../state/turnStore.js";

function appendAssistantMessage(messages: ChatMessage[], content: string): ChatMessage[] {
  return [...messages, { role: "assistant", content }];
}

function archiveAssistantMessage(state: ReplViewModel, content: string): ChatMessage[] {
  return [
    ...state.messages,
    {
      role: "assistant",
      content,
      ...(state.activeTurn.tools.length ? { toolUses: state.activeTurn.tools } : {}),
    },
  ];
}

export function projectUiEvent(state: ReplViewModel, event: UiEvent): ReplViewModel {
  const withActiveTurn = (next: Omit<ReplViewModel, "activeTurn">): ReplViewModel => ({
    ...next,
    activeTurn: reduceActiveTurn(state.activeTurn, event),
  });

  switch (event.type) {
    case "user.submitted":
      return withActiveTurn({
        ...state,
        messages: [...state.messages, { role: "user", content: event.text }],
      });

    case "assistant.started":
      return withActiveTurn({
        ...state,
        messages: state.messages,
      });

    case "assistant.delta":
      return withActiveTurn({
        ...state,
        messages: state.messages,
      });

    case "assistant.updated":
      return withActiveTurn({
        ...state,
        messages: state.messages,
      });

    case "assistant.completed":
      return withActiveTurn({
        ...state,
        messages: archiveAssistantMessage(state, event.text),
      });

    case "assistant.failed":
      return withActiveTurn({
        ...state,
        messages: archiveAssistantMessage(
          state,
          event.preservePartial && state.activeTurn.text ? state.activeTurn.text : event.message,
        ),
      });

    case "tool.started":
      return withActiveTurn({
        ...state,
        messages: state.messages,
      });

    case "tool.completed":
      return withActiveTurn({
        ...state,
        messages: state.messages,
      });

    case "routing.failed":
      return withActiveTurn({
        ...state,
        messages: appendAssistantMessage(state.messages, event.message),
      });

    case "status.changed":
      return withActiveTurn({ ...state, status: event.status });

    case "usage.updated":
      return withActiveTurn({
        ...state,
        usage: {
          inputTotal: state.usage.inputTotal + (event.usage.inputTotal ?? 0),
          outputTotal: state.usage.outputTotal + (event.usage.outputTotal ?? 0),
          cacheWriteTotal: state.usage.cacheWriteTotal + (event.usage.cacheWriteTotal ?? 0),
          cacheReadTotal: state.usage.cacheReadTotal + (event.usage.cacheReadTotal ?? 0),
          costUsd: event.usage.costUsd ?? state.usage.costUsd,
        },
      });
  }
}

export function projectUiEvents(state: ReplViewModel, events: UiEvent[]): ReplViewModel {
  return events.reduce(projectUiEvent, state);
}
