import type { HarnessState, TaskFlow } from "@open-vera/core/types";

// ── Valid transition map ────────────────────────────────────────────────────────

const VALID_TRANSITIONS: Record<HarnessState, Set<HarnessState>> = {
  intaking:          new Set(["planning", "completed"]),
  planning:          new Set(["dispatching", "failed"]),
  dispatching:       new Set(["executing", "completed", "waiting_approval"]),
  executing:         new Set(["waiting_tool", "waiting_approval", "critiquing", "failed"]),
  waiting_tool:      new Set(["executing", "failed"]),
  waiting_approval:  new Set(["executing", "dispatching", "failed", "paused"]),
  critiquing:        new Set(["dispatching", "replanning", "waiting_approval", "completed"]),
  replanning:        new Set(["dispatching", "failed"]),
  paused:            new Set(["dispatching", "executing", "failed"]),
  completed:         new Set([]),  // terminal
  failed:            new Set([]),  // terminal
};

// ── Terminal states ─────────────────────────────────────────────────────────────

const TERMINAL: Set<HarnessState> = new Set(["completed", "failed"]);

export function isTerminal(state: HarnessState): boolean {
  return TERMINAL.has(state);
}

// ── Transition helpers ──────────────────────────────────────────────────────────

/**
 * Check whether a state transition is valid.
 */
export function canTransition(from: HarnessState, to: HarnessState): boolean {
  return VALID_TRANSITIONS[from]?.has(to) ?? false;
}

/**
 * Assert that `from → to` is a legal transition. Throws if not.
 */
export function assertTransition(from: HarnessState, to: HarnessState): void {
  if (!canTransition(from, to)) {
    throw new Error(`Illegal flow state transition: ${from} → ${to}`);
  }
}

/**
 * Transition a TaskFlow to a new state, asserting validity.
 * Returns a new flow object (immutable update).
 */
export function transitionFlow(flow: TaskFlow, to: HarnessState): TaskFlow {
  assertTransition(flow.state, to);
  return { ...flow, state: to };
}

// ── Batch transitions (convenience) ─────────────────────────────────────────────

/**
 * Transition through intermediate states in order.
 * Each step must be a valid transition from the previous state.
 * Stops and returns early if any step is invalid.
 */
export function transitionFlowPath(flow: TaskFlow, path: HarnessState[]): TaskFlow {
  let current = flow;
  for (const next of path) {
    current = transitionFlow(current, next);
  }
  return current;
}

// ── State queries ────────────────────────────────────────────────────────────────

/** Whether the flow has finished (success or failure). */
export function isFlowDone(flow: TaskFlow): boolean {
  return isTerminal(flow.state);
}

/** Whether the flow is in a state that can be resumed after interruption. */
export function isFlowPausable(flow: TaskFlow): boolean {
  return flow.state === "executing" || flow.state === "dispatching";
}

/** Whether the flow is waiting for external input (approval or unpause). */
export function isFlowWaiting(flow: TaskFlow): boolean {
  return flow.state === "waiting_approval" || flow.state === "paused";
}
