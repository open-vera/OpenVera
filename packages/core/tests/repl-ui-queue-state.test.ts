import { describe, expect, it } from "vitest";
import {
  dequeueInput,
  emptyQueue,
  enqueueInput,
  prependInput,
  removeQueuedInput,
  updateQueuedInput,
} from "../src/repl/ui/state/queueState.js";
import { createQueueController } from "../src/repl/ui/controller/useReplController.js";

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

  it("controller dequeue returns synchronously from its internal queue state", () => {
    const controller = createQueueController();

    controller.enqueue("one");
    controller.enqueue("two");

    expect(controller.dequeue()).toEqual({ state: { items: ["two"] }, next: "one" });
    expect(controller.getState()).toEqual({ items: ["two"] });
    expect(controller.prepend("zero")).toEqual({ items: ["zero", "two"] });
    expect(controller.updateQueued(1, "updated")).toEqual({ items: ["zero", "updated"] });
    expect(controller.removeQueued(0)).toEqual({ items: ["updated"] });
    expect(controller.clearQueue()).toEqual({ items: [] });
  });
});
