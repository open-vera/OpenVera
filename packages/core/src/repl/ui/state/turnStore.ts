import type { ToolUse } from "../types.js";
import type { UiEvent } from "../events.js";

export interface ActiveToolState {
  name: string;
  args: Record<string, unknown>;
  liveOutput: string;
}

export interface ActiveTurnState {
  active: boolean;
  text: string;
  thinkingText: string;
  tools: ToolUse[];
  inputTokens: number;
  outputTokens: number;
  status: "idle" | "streaming" | "failed" | "completed";
  activeTool?: ActiveToolState;
}

export const emptyActiveTurn = (): ActiveTurnState => ({
  active: false,
  text: "",
  thinkingText: "",
  tools: [],
  inputTokens: 0,
  outputTokens: 0,
  status: "idle",
});

export function reduceActiveTurn(state: ActiveTurnState, event: UiEvent): ActiveTurnState {
  switch (event.type) {
    case "assistant.started":
      return { active: true, text: "", thinkingText: "", tools: [], inputTokens: 0, outputTokens: 0, status: "streaming" };

    case "assistant.thinking.delta":
      return state.active
        ? { ...state, thinkingText: state.thinkingText + event.delta }
        : { active: true, text: "", thinkingText: event.delta, tools: [], inputTokens: 0, outputTokens: 0, status: "streaming" };

    case "assistant.thinking.updated":
      return state.active
        ? { ...state, thinkingText: event.text }
        : { active: true, text: "", thinkingText: event.text, tools: [], inputTokens: 0, outputTokens: 0, status: "streaming" };

    case "assistant.delta":
      return state.active
        ? { ...state, text: state.text + event.delta, status: "streaming" }
        : { active: true, text: event.delta, thinkingText: "", tools: [], inputTokens: 0, outputTokens: 0, status: "streaming" };

    case "assistant.updated":
      return state.active
        ? { ...state, text: event.text, status: "streaming" }
        : { active: true, text: event.text, thinkingText: "", tools: [], inputTokens: 0, outputTokens: 0, status: "streaming" };

    case "tool.started":
      return state.active
        ? { ...state, text: "", activeTool: { name: event.name, args: event.args, liveOutput: "" } }
        : state;

    case "tool.output":
      if (!state.active || !state.activeTool) return state;
      return {
        ...state,
        activeTool: {
          ...state.activeTool,
          liveOutput: state.activeTool.liveOutput + event.chunk,
        },
      };

    case "tool.completed":
      return state.active
        ? { ...state, tools: [...state.tools, event.tool], activeTool: undefined }
        : { active: true, text: "", thinkingText: "", tools: [event.tool], inputTokens: 0, outputTokens: 0, status: "streaming", activeTool: undefined };

    case "assistant.completed":
      return { ...state, active: false, text: event.text, status: "completed" };

    case "assistant.failed":
      return {
        ...state,
        active: false,
        text: event.preservePartial && state.text ? state.text : event.message,
        status: "failed",
      };

    case "user.submitted":
    case "routing.failed":
    case "status.changed":
      return state;

    case "usage.updated": {
      const inputDelta = event.inputTokensDelta ?? 0;
      const delta = event.outputTokensDelta ?? 0;
      return inputDelta || delta
        ? { ...state, inputTokens: state.inputTokens + inputDelta, outputTokens: state.outputTokens + delta }
        : state;
    }
  }
}
