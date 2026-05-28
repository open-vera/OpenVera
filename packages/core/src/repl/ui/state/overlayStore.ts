import type { BlockingPrompt } from "./blockingPrompt.js";
import { debugLog } from "../../debugLog.js";

export type OverlayState =
  | { type: "none" }
  | { type: "diff" }
  | { type: "sessionPicker" }
  | { type: "prompt"; prompt: BlockingPrompt };

export type OverlayAction =
  | { type: "open.diff" }
  | { type: "open.sessionPicker" }
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
    case "open.prompt":
      return { type: "prompt", prompt: action.prompt };
    case "close":
      return { type: "none" };
  }
}
