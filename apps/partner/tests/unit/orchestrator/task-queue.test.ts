import { describe, expect, it } from "vitest";
import { TaskQueue } from "@/orchestrator/task-queue";

describe("TaskQueue", () => {
  it("enqueues and dequeues tasks in order", () => {
    const queue = new TaskQueue();
    queue.enqueue({
      id: "t1",
      title: "First",
      steps: [],
      createdAt: Date.now(),
    });
    queue.enqueue({
      id: "t2",
      title: "Second",
      steps: [],
      createdAt: Date.now(),
    });

    expect(queue.size()).toBe(2);
    expect(queue.dequeue()?.id).toBe("t1");
    expect(queue.peek()?.id).toBe("t2");
  });

  it("can clear queued tasks explicitly", () => {
    const queue = new TaskQueue();
    queue.enqueue({
      id: "t1",
      title: "First",
      steps: [],
      createdAt: Date.now(),
    });
    queue.enqueue({
      id: "t2",
      title: "Second",
      steps: [],
      createdAt: Date.now(),
    });

    queue.clear();

    expect(queue.size()).toBe(0);
    expect(queue.dequeue()).toBeUndefined();
  });

  it("promotes a queued task to the front", () => {
    const queue = new TaskQueue();
    queue.enqueue({
      id: "t1",
      title: "First",
      steps: [],
      createdAt: Date.now(),
    });
    queue.enqueue({
      id: "t2",
      title: "Second",
      steps: [],
      createdAt: Date.now(),
    });

    expect(queue.promote("t2")).toBe(true);
    expect(queue.dequeue()?.id).toBe("t2");
    expect(queue.dequeue()?.id).toBe("t1");
  });
});
