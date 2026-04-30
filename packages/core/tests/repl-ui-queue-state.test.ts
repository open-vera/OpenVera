import { describe, expect, it } from "vitest";
import {
  dequeueInput,
  emptyQueue,
  enqueueInput,
  prependInput,
  removeQueuedInput,
  updateQueuedInput,
} from "../src/repl/ui/state/queueState.js";

describe("queueState", () => {
  it("enqueues trimmed non-empty input", () => {
    expect(enqueueInput(emptyQueue(), "  hello  ")).toEqual({ items: ["hello"] });
    expect(prependInput({ items: ["later"] }, " now ")).toEqual({ items: ["now", "later"] });
    expect(enqueueInput(emptyQueue(), "   ")).toEqual({ items: [] });
  });

  it("dequeues inputs in FIFO order", () => {
    const queued = { items: ["one", "two"] };
    const first = dequeueInput(queued);
    expect(first).toEqual({ state: { items: ["two"] }, next: "one" });
    expect(dequeueInput(first.state)).toEqual({ state: { items: [] }, next: "two" });
  });

  it("updates and removes queued input", () => {
    const queued = { items: ["one", "two"] };
    expect(updateQueuedInput(queued, 1, " updated ")).toEqual({ items: ["one", "updated"] });
    expect(updateQueuedInput(queued, 0, " ")).toEqual({ items: ["two"] });
    expect(removeQueuedInput(queued, 0)).toEqual({ items: ["two"] });
  });
});
