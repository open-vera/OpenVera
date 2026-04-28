import type { MutableRefObject } from "react";
import type { PlanEvent, PlanStepUI } from "../../../plan/index.js";
import type { ChatMessage, StreamStatus, ToolUse } from "../types.js";

export interface PlanRunnerProps {
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  setStreamStatus: React.Dispatch<React.SetStateAction<StreamStatus>>;
  planStepsRef: MutableRefObject<PlanStepUI[]>;
  planStepTextRef: MutableRefObject<string>;
  planRafRef: MutableRefObject<ReturnType<typeof setTimeout> | null>;
}

export function buildPlanEventHandler(props: PlanRunnerProps) {
  const { setMessages, setStreamStatus, planStepsRef, planStepTextRef, planRafRef } = props;

  return function handlePlanEvent(event: PlanEvent): void {
    switch (event.type) {
      case "plan_ready": {
        const doneById = new Map(
          planStepsRef.current.filter((s) => s.status === "done").map((s) => [s.id, s])
        );
        const steps: PlanStepUI[] = event.steps.map((s) =>
          doneById.get(s.id) ?? { id: s.id, description: s.description, status: "pending" as const, content: "", toolUses: [] }
        );
        planStepsRef.current = steps;
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (!last?.planMode) return prev;
          return [...prev.slice(0, -1), { ...last, planSteps: steps }];
        });
        setStreamStatus("streaming");
        break;
      }
      case "step_start": {
        planStepTextRef.current = "";
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (!last?.planMode) return prev;
          const steps = (last.planSteps ?? []).map((s, i) =>
            i === event.stepIndex ? { ...s, status: "running" as const } : s
          );
          return [...prev.slice(0, -1), { ...last, planSteps: steps, activeStepIndex: event.stepIndex }];
        });
        break;
      }
      case "step_text": {
        planStepTextRef.current += event.delta;
        if (planRafRef.current === null) {
          planRafRef.current = setTimeout(() => {
            const text = planStepTextRef.current;
            setMessages((prev) => {
              const last = prev[prev.length - 1];
              if (!last?.planMode || last.activeStepIndex == null || last.activeStepIndex < 0) return prev;
              const idx = last.activeStepIndex;
              const steps = (last.planSteps ?? []).map((s, i) => i === idx ? { ...s, content: text } : s);
              return [...prev.slice(0, -1), { ...last, planSteps: steps }];
            });
            planRafRef.current = null;
          }, 16);
        }
        break;
      }
      case "step_tool": {
        const toolUse: ToolUse = { name: event.name, args: event.args, result: event.result };
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (!last?.planMode || last.activeStepIndex == null) return prev;
          const idx = last.activeStepIndex;
          const steps = (last.planSteps ?? []).map((s, i) =>
            i === idx ? { ...s, toolUses: [...s.toolUses, toolUse] } : s
          );
          return [...prev.slice(0, -1), { ...last, planSteps: steps }];
        });
        const runningIdx = planStepsRef.current.findIndex((s) => s.status === "running");
        if (runningIdx >= 0) planStepsRef.current[runningIdx]!.toolUses.push(toolUse);
        break;
      }
      case "step_done": {
        if (planRafRef.current !== null) { clearTimeout(planRafRef.current); planRafRef.current = null; }
        const finalText = planStepTextRef.current;
        if (planStepsRef.current[event.stepIndex]) {
          planStepsRef.current[event.stepIndex]!.status = "done";
          planStepsRef.current[event.stepIndex]!.content = finalText;
        }
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (!last?.planMode) return prev;
          const steps = (last.planSteps ?? []).map((s, i) =>
            i === event.stepIndex ? { ...s, status: "done" as const, content: finalText } : s
          );
          return [...prev.slice(0, -1), { ...last, planSteps: steps }];
        });
        break;
      }
      case "plan_done": {
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (!last?.planMode) return prev;
          return [...prev.slice(0, -1), { ...last, streaming: false, activeStepIndex: undefined }];
        });
        break;
      }
      case "plan_error": {
        if (planRafRef.current !== null) { clearTimeout(planRafRef.current); planRafRef.current = null; }
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (!last?.planMode) return prev;
          return [...prev.slice(0, -1), { ...last, content: `Error: ${event.error}`, streaming: false, planMode: false }];
        });
        break;
      }
    }
  };
}
