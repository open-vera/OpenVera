/**
 * Type-safe event bus for Harness lifecycle events.
 *
 * Plugins subscribe to events via `on()` / `once()`. The runtime emits events
 * at key lifecycle points (flow start/complete, step dispatch/critique, etc.).
 */

import type {
  ExecutionPlan,
  StepResult,
} from "@open-vera/core/types";
import type { PlanDiff, FlowLoopResult } from "./types.js";

// ---------------------------------------------------------------------------
// Event type map
// ---------------------------------------------------------------------------

export interface HarnessEvents {
  // Flow level
  "flow:start": { flowId: string; plan: ExecutionPlan };
  "flow:complete": { flowId: string; result: FlowLoopResult };
  "flow:fail": { flowId: string; error: Error };

  // Plan level
  "plan:generated": { plan: ExecutionPlan };
  "plan:challenged": { score: number; passed: boolean };
  "plan:replan": { diff: PlanDiff };

  // Step level
  "step:start": { stepId: string; agents: string[] };
  "step:done": { stepId: string; result: StepResult };
  "step:challenged": { stepId: string; score: number; passed: boolean };
  "step:rework": { stepId: string; fixes: string[] };

  // Agent level
  "agent:start": { stepId: string; agent: string };
  "agent:done": { stepId: string; agent: string; outputs: string[] };
}

// ---------------------------------------------------------------------------
// Listener type
// ---------------------------------------------------------------------------

export type EventListener<K extends keyof HarnessEvents> = (
  payload: HarnessEvents[K],
) => void | Promise<void>;

// ---------------------------------------------------------------------------
// Event bus
// ---------------------------------------------------------------------------

export class HarnessEventBus {
  private readonly listeners = new Map<
    keyof HarnessEvents,
    Set<EventListener<any>>
  >();

  /** Subscribe to an event. Returns an unsubscribe function. */
  on<K extends keyof HarnessEvents>(
    event: K,
    listener: EventListener<K>,
  ): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
    };
  }

  /** Subscribe to an event; the listener is automatically removed after first call. */
  once<K extends keyof HarnessEvents>(
    event: K,
    listener: EventListener<K>,
  ): () => void {
    const unsub = this.on(event, ((payload: HarnessEvents[K]) => {
      unsub();
      return listener(payload);
    }) as EventListener<K>);
    return unsub;
  }

  /**
   * Emit an event, invoking all registered listeners sequentially.
   * Async listeners are awaited.
   */
  async emit<K extends keyof HarnessEvents>(
    event: K,
    payload: HarnessEvents[K],
  ): Promise<void> {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const listener of set) {
      await listener(payload);
    }
  }

  /** Remove all listeners for a specific event, or all events if no key given. */
  removeAll(event?: keyof HarnessEvents): void {
    if (event) {
      this.listeners.delete(event);
    } else {
      this.listeners.clear();
    }
  }

  /** Returns the number of listeners for a given event. */
  listenerCount(event: keyof HarnessEvents): number {
    return this.listeners.get(event)?.size ?? 0;
  }
}
