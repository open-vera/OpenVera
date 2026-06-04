import type { BlockingPrompt } from "./blockingPrompt.js";
import { debugLog } from "../../debugLog.js";

export interface ProviderEntry {
  name: string;
  adapter: string;
  base_url?: string;
}

export interface ModelEntry {
  id: string;
  provider: string;
  display_name?: string;
  context_window?: number;
}

export type OverlayState =
  | { type: "none" }
  | { type: "diff" }
  | { type: "sessionPicker" }
  | { type: "providerPicker"; providers: ProviderEntry[]; currentProvider: string }
  | { type: "modelPicker"; models: ModelEntry[]; currentModel: string; currentProvider: string }
  | { type: "prompt"; prompt: BlockingPrompt };

export type OverlayAction =
  | { type: "open.diff" }
  | { type: "open.sessionPicker" }
  | { type: "open.providerPicker"; providers: ProviderEntry[]; currentProvider: string }
  | { type: "open.modelPicker"; models: ModelEntry[]; currentModel: string; currentProvider: string }
  | { type: "open.prompt"; prompt: BlockingPrompt }
  | { type: "close" };

export function emptyOverlay(): OverlayState {
  return { type: "none" };
}

export function reduceOverlay(state: OverlayState, action: OverlayAction): OverlayState {
  debugLog(`[overlay] ${state.type} → ${action.type}`);
  switch (action.type) {
    case "open.diff":
      return { type: "diff" };
    case "open.sessionPicker":
      return { type: "sessionPicker" };
    case "open.providerPicker":
      return { type: "providerPicker", providers: action.providers, currentProvider: action.currentProvider };
    case "open.modelPicker":
      return { type: "modelPicker", models: action.models, currentModel: action.currentModel, currentProvider: action.currentProvider };
    case "open.prompt":
      return { type: "prompt", prompt: action.prompt };
    case "close":
      return { type: "none" };
  }
}
