import { describe, it, expect, vi, beforeEach } from "vitest";
import type { MutableRefObject } from "react";
import { buildPlanEventHandler } from "../src/repl/ui/hooks/usePlanRunner.js";
import type { PlanStepUI, PlanEvent } from "../src/plan/index.js";
import type { ChatMessage, StreamStatus } from "../src/repl/ui/types.js";

describe("usePlanRunner", () => {
  describe("buildPlanEventHandler", () => {
    let setMessages: ReturnType<typeof vi.fn>;
    let setStreamStatus: ReturnType<typeof vi.fn>;
    let planStepsRef: MutableRefObject<PlanStepUI[]>;
    let planStepTextRef: MutableRefObject<string>;
    let planRafRef: MutableRefObject<ReturnType<typeof setTimeout> | null>;

    beforeEach(() => {
      setMessages = vi.fn((updater) => {
        // Simulate state update
        if (typeof updater === "function") {
          return updater([]);
        }
        return updater;
      });

      setStreamStatus = vi.fn();

      planStepsRef = { current: [] };
      planStepTextRef = { current: "" };
      planRafRef = { current: null };
    });

    it("handles plan_ready event by initializing steps", () => {
      const handler = buildPlanEventHandler({
        setMessages,
        setStreamStatus,
        planStepsRef,
        planStepTextRef,
        planRafRef,
      });

      const event: PlanEvent = {
        type: "plan_ready",
        steps: [
          { id: "1", description: "First step" },
          { id: "2", description: "Second step" },
        ],
      };

      handler(event);

      expect(planStepsRef.current).toHaveLength(2);
      expect(planStepsRef.current[0]?.id).toBe("1");
      expect(planStepsRef.current[0]?.description).toBe("First step");
      expect(planStepsRef.current[0]?.status).toBe("pending");
      expect(setStreamStatus).toHaveBeenCalledWith("streaming");
    });

    it("preserves done steps when ready is called again", () => {
      planStepsRef.current = [
        { id: "1", description: "First", status: "done", content: "done content", toolUses: [] },
        { id: "2", description: "Second", status: "pending", content: "", toolUses: [] },
      ];

      const handler = buildPlanEventHandler({
        setMessages,
        setStreamStatus,
        planStepsRef,
        planStepTextRef,
        planRafRef,
      });

      const event: PlanEvent = {
        type: "plan_ready",
        steps: [
          { id: "1", description: "Updated first" },
          { id: "2", description: "Updated second" },
        ],
      };

      handler(event);

      expect(planStepsRef.current[0]?.status).toBe("done");
      expect(planStepsRef.current[0]?.content).toBe("done content");
      expect(planStepsRef.current[1]?.status).toBe("pending");
    });

    it("handles step_start event", () => {
      planStepsRef.current = [
        { id: "1", description: "First", status: "pending", content: "", toolUses: [] },
        { id: "2", description: "Second", status: "pending", content: "", toolUses: [] },
      ];

      const handler = buildPlanEventHandler({
        setMessages,
        setStreamStatus,
        planStepsRef,
        planStepTextRef,
        planRafRef,
      });

      const event: PlanEvent = { type: "step_start", stepIndex: 0 };
      handler(event);

      expect(planStepTextRef.current).toBe("");
      expect(setMessages).toHaveBeenCalled();
    });

    it("handles step_text event and accumulates text", () => {
      planStepsRef.current = [
        { id: "1", description: "First", status: "running", content: "", toolUses: [] },
      ];

      const handler = buildPlanEventHandler({
        setMessages,
        setStreamStatus,
        planStepsRef,
        planStepTextRef,
        planRafRef,
      });

      const event1: PlanEvent = { type: "step_text", delta: "Hello " };
      const event2: PlanEvent = { type: "step_text", delta: "World" };

      handler(event1);
      handler(event2);

      expect(planStepTextRef.current).toBe("Hello World");
      // RAF timer should be set
      expect(planRafRef.current).not.toBeNull();
    });

    it("handles step_tool event", () => {
      planStepsRef.current = [
        { id: "1", description: "First", status: "running", content: "", toolUses: [] },
      ];

      const handler = buildPlanEventHandler({
        setMessages,
        setStreamStatus,
        planStepsRef,
        planStepTextRef,
        planRafRef,
      });

      const event: PlanEvent = {
        type: "step_tool",
        stepIndex: 0,
        name: "read_file",
        args: { path: "test.txt" },
        result: { ok: true, content: "file contents" },
      };

      handler(event);

      expect(planStepsRef.current[0]?.toolUses).toHaveLength(1);
      expect(planStepsRef.current[0]?.toolUses[0]?.name).toBe("read_file");
    });

    it("handles step_done event", () => {
      planStepsRef.current = [
        { id: "1", description: "First", status: "running", content: "", toolUses: [] },
      ];
      planStepTextRef.current = "Step content";
      planRafRef.current = 123 as unknown as ReturnType<typeof setTimeout>;

      const handler = buildPlanEventHandler({
        setMessages,
        setStreamStatus,
        planStepsRef,
        planStepTextRef,
        planRafRef,
      });

      const event: PlanEvent = { type: "step_done", stepIndex: 0 };
      handler(event);

      expect(planStepsRef.current[0]?.status).toBe("done");
      expect(planStepsRef.current[0]?.content).toBe("Step content");
      expect(planRafRef.current).toBeNull();
    });

    it("handles plan_done event", () => {
      const handler = buildPlanEventHandler({
        setMessages,
        setStreamStatus,
        planStepsRef,
        planStepTextRef,
        planRafRef,
      });

      const event: PlanEvent = { type: "plan_done" };
      handler(event);

      expect(setMessages).toHaveBeenCalled();
    });

    it("handles plan_error event", () => {
      planRafRef.current = 456 as unknown as ReturnType<typeof setTimeout>;

      const handler = buildPlanEventHandler({
        setMessages,
        setStreamStatus,
        planStepsRef,
        planStepTextRef,
        planRafRef,
      });

      const event: PlanEvent = { type: "plan_error", error: "Something went wrong" };
      handler(event);

      expect(planRafRef.current).toBeNull();
      expect(setMessages).toHaveBeenCalled();
    });
  });
});
