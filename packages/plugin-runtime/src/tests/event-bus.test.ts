import { describe, expect, it } from "vitest";
import { EventBus, HookExecutionError } from "../event-bus.js";

describe("EventBus", () => {
  it("uses first handled intercept result and respects priority", async () => {
    const bus = new EventBus();
    bus.intercept("tool:before:*", () => ({ handled: true, result: "low" }), {
      pluginId: "low",
      priority: 1,
    });
    bus.intercept("tool:before:read_file", () => ({ handled: true, result: "high" }), {
      pluginId: "high",
      priority: 10,
    });

    await expect(bus.emitIntercept("tool:before:read_file", "input", { pluginId: "host" }))
      .resolves.toEqual({ handled: true, result: "high" });
  });

  it("serially transforms values", async () => {
    const bus = new EventBus();
    bus.transform<number>("llm:request", (event) => event.value + 1, { priority: 10 });
    bus.transform<number>("llm:*", (event) => event.value * 2, { priority: 1 });

    await expect(bus.emitTransform("llm:request", 2, { pluginId: "host" })).resolves.toBe(6);
  });

  it("runs observers fail-open", async () => {
    const bus = new EventBus();
    const seen: string[] = [];
    bus.observe("flow:*:error", () => {
      throw new Error("observer failed");
    });
    bus.observe("flow:run:error", () => {
      seen.push("ok");
    });

    await expect(bus.emitObserve("flow:run:error", {}, { pluginId: "host" })).resolves.toBeUndefined();
    expect(seen).toEqual(["ok"]);
  });

  it("fails closed for critical timed-out transforms", async () => {
    const bus = new EventBus();
    bus.transform(
      "llm:request",
      () => new Promise((resolve) => setTimeout(() => resolve("late"), 50)),
      {
        critical: true,
        timeoutMs: 5,
      },
    );

    await expect(bus.emitTransform("llm:request", "input", { pluginId: "host" }))
      .rejects.toBeInstanceOf(HookExecutionError);
  });

  it("fails open for non-critical timed-out transforms", async () => {
    const bus = new EventBus();
    bus.transform(
      "llm:request",
      () => new Promise((resolve) => setTimeout(() => resolve("late"), 50)),
      {
        timeoutMs: 5,
      },
    );

    await expect(bus.emitTransform("llm:request", "input", { pluginId: "host" })).resolves.toBe("input");
  });
});
