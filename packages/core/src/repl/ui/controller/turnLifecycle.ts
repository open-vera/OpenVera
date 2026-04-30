import type { PlanStepUI } from "../../../plan/index.js";
import type { ChatMessage } from "../types.js";

export const ROUTING_FAILED_MESSAGE = "⚠ routing failed — using default model";

export function appendRoutingFailedMessage(messages: ChatMessage[], failed: boolean): ChatMessage[] {
  return failed ? [...messages, { role: "assistant", content: ROUTING_FAILED_MESSAGE }] : messages;
}

export function appendPlanPlaceholder(messages: ChatMessage[], routingFailed: boolean): ChatMessage[] {
  return [
    ...appendRoutingFailedMessage(messages, routingFailed),
    {
      role: "assistant",
      content: "",
      streaming: true,
      planMode: true,
      planSteps: [],
      activeStepIndex: -1,
    },
  ];
}

export function summarizePlanSteps(steps: PlanStepUI[]): string {
  return steps.map((step, index) => `步骤 ${index + 1}：${step.description}\n${step.content}`).join("\n\n");
}

export function reducePlanRuntimeError(messages: ChatMessage[], message: string, isAbort: boolean): ChatMessage[] {
  const last = messages[messages.length - 1];
  if (!last?.planMode) return messages;
  if (isAbort) {
    return [...messages.slice(0, -1), { ...last, streaming: false }];
  }
  return [...messages.slice(0, -1), { ...last, content: message, streaming: false, planMode: false }];
}
