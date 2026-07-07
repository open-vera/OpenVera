<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { approveAgentTool } from "@/bridge/agent";
import type { ToolCall, ToolResult } from "@/types";
import {
  compactToolProgress,
  groupToolProgress,
  isVisibleToolProgressStep,
  summarizeToolCall,
  type ToolProgressStep,
} from "@/utils/tool-progress";
import MarkdownRenderer from "./MarkdownRenderer.vue";

const props = defineProps<{
  toolCalls: ToolCall[];
  toolResults?: ToolResult[];
  running?: boolean;
}>();

const expanded = ref(false);
const approvalStates = ref<Record<string, "pending" | "approved" | "denied" | "error">>({});

const locale = computed(() => navigator.language);
const steps = computed(() =>
  props.toolCalls.map((toolCall) => summarizeToolCall(toolCall, locale.value)),
);
const progressSteps = computed(() => steps.value.filter(isVisibleToolProgressStep));
const groups = computed(() => groupToolProgress(progressSteps.value));
const visibleGroups = computed(() => {
  if (expanded.value) return groups.value;
  return props.running ? compactToolProgress(groups.value) : [];
});
const totalSteps = computed(() => progressSteps.value.length);
const hasVisibleSteps = computed(() => totalSteps.value > 0);
const visibleStepCount = computed(() =>
  visibleGroups.value.reduce((count, group) => count + group.steps.length, 0),
);
const hiddenStepCount = computed(() =>
  expanded.value ? 0 : Math.max(0, totalSteps.value - visibleStepCount.value),
);
const resultByCallId = computed(() => {
  const items = new Map<string, ToolResult>();
  for (const result of props.toolResults ?? []) {
    items.set(result.id, result);
  }
  return items;
});
const isZh = computed(() => locale.value.toLowerCase().startsWith("zh"));
const headerText = computed(() => {
  return isZh.value
    ? `已执行 ${totalSteps.value} 个步骤`
    : `${totalSteps.value} steps completed`;
});
const toggleText = computed(() => {
  if (isZh.value) {
    return expanded.value ? "收起" : "展开全部";
  }
  return expanded.value ? "Collapse" : "Expand all";
});

function rawString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  return typeof value === "string" ? value : "";
}

function rawStringArray(input: Record<string, unknown>, key: string): string[] {
  const value = input[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function isApprovalStep(step: ToolProgressStep): boolean {
  return step.rawName === "tool_approval_required";
}

function approvalCallId(step: ToolProgressStep): string {
  return rawString(step.rawInput, "callId") || step.id;
}

function approvalCommand(step: ToolProgressStep): string {
  const cmd = rawString(step.rawInput, "cmd");
  const args = rawStringArray(step.rawInput, "args");
  return [cmd, ...args].filter(Boolean).join(" ");
}

function approvalReason(step: ToolProgressStep): string {
  return rawString(step.rawInput, "reason");
}

function approvalState(step: ToolProgressStep) {
  return approvalStates.value[approvalCallId(step)] ?? "pending";
}

function toolResult(step: ToolProgressStep): ToolResult | undefined {
  return resultByCallId.value.get(step.id);
}

function resultPreview(result: ToolResult): string {
  const text = result.output.trim();
  if (!text) return result.isError ? "命令执行失败，无输出" : "命令执行成功，无输出";
  return text.length > 4_000 ? `${text.slice(0, 4_000)}\n…` : text;
}

function resultLabel(result: ToolResult): string {
  if (isZh.value) return result.isError ? "执行结果（失败）" : "执行结果";
  return result.isError ? "Result (failed)" : "Result";
}

async function resolveApproval(step: ToolProgressStep, approved: boolean) {
  const callId = approvalCallId(step);
  try {
    await approveAgentTool(callId, approved);
    approvalStates.value[callId] = approved ? "approved" : "denied";
  } catch (error) {
    approvalStates.value[callId] = "error";
    console.warn("[ToolApproval] failed to resolve approval:", error);
  }
}

watch(
  () => props.running,
  (running) => {
    if (!running) {
      expanded.value = false;
    }
  },
);
</script>

<template>
  <section v-if="hasVisibleSteps" class="tool-progress" :class="{ completed: !running, expanded }">
    <button type="button" class="tool-progress-header" @click="expanded = !expanded">
      <span class="header-title">{{ headerText }}</span>
      <span class="header-meta">{{ toggleText }}</span>
    </button>

    <div v-if="visibleGroups.length" class="progress-groups">
      <div v-if="expanded && hiddenStepCount > 0" class="progress-ellipsis" aria-label="Earlier steps omitted">
        ...
      </div>
      <section
        v-for="group in visibleGroups"
        :key="`${group.category}:${group.steps[0]?.id}`"
        class="progress-group"
        :class="`category-${group.category}`"
      >
        <div v-if="expanded" class="group-title">{{ group.title }}</div>
        <ol class="step-list">
          <li v-for="step in group.steps" :key="step.id" class="step-item">
            <span class="step-dot" aria-hidden="true" />
            <span v-if="!isApprovalStep(step)" class="step-body">
              <span class="step-detail">{{ step.detail }}</span>
              <span
                v-if="expanded && toolResult(step)"
                class="tool-result"
                :class="{ error: toolResult(step)?.isError }"
              >
                <span class="tool-result-label">{{ resultLabel(toolResult(step)!) }}</span>
                <MarkdownRenderer :content="resultPreview(toolResult(step)!)" />
              </span>
            </span>
            <span v-else class="approval-card">
              <span class="approval-title">{{ step.detail }}</span>
              <span v-if="approvalCommand(step)" class="approval-command">
                {{ approvalCommand(step) }}
              </span>
              <span v-if="approvalReason(step)" class="approval-reason">
                {{ approvalReason(step) }}
              </span>
              <span class="approval-actions">
                <button
                  type="button"
                  class="approval-button primary"
                  :disabled="approvalState(step) !== 'pending'"
                  @click="resolveApproval(step, true)"
                >
                  {{ isZh ? "授权执行" : "Allow" }}
                </button>
                <button
                  type="button"
                  class="approval-button"
                  :disabled="approvalState(step) !== 'pending'"
                  @click="resolveApproval(step, false)"
                >
                  {{ isZh ? "拒绝" : "Deny" }}
                </button>
                <span v-if="approvalState(step) === 'approved'" class="approval-status">
                  {{ isZh ? "已授权" : "Allowed" }}
                </span>
                <span v-else-if="approvalState(step) === 'denied'" class="approval-status">
                  {{ isZh ? "已拒绝" : "Denied" }}
                </span>
                <span v-else-if="approvalState(step) === 'error'" class="approval-status error">
                  {{ isZh ? "提交失败" : "Failed" }}
                </span>
              </span>
            </span>
          </li>
        </ol>
      </section>
    </div>
  </section>
</template>

<style scoped>
.tool-progress {
  align-self: flex-start;
  width: min(86%, 760px);
  font-size: 13px;
}

.tool-progress.completed {
  color: color-mix(in srgb, var(--text-muted) 72%, transparent);
}

.tool-progress-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  width: 100%;
  border: none;
  padding: 4px 0 6px;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.completed .tool-progress-header {
  padding-top: 2px;
  padding-bottom: 2px;
  opacity: 0.78;
}

.completed .tool-progress-header:hover {
  opacity: 1;
}

.tool-progress.expanded .tool-progress-header {
  position: sticky;
  top: 8px;
  z-index: 2;
  margin-bottom: 10px;
  padding: 6px 8px;
  border: 1px solid color-mix(in srgb, var(--border) 62%, transparent);
  border-radius: 8px;
  background: color-mix(in srgb, var(--surface) 92%, transparent);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.14);
  backdrop-filter: blur(8px);
}

.tool-progress.expanded .tool-progress-header:hover {
  background: color-mix(in srgb, var(--surface-hover) 88%, transparent);
}

.header-title {
  font-weight: 600;
}

.completed .header-title {
  font-weight: 500;
}

.has-error .header-title {
  color: #ff8a8a;
}

.header-meta {
  flex-shrink: 0;
  color: var(--text-muted);
  font-size: 12px;
}

.completed .header-meta {
  opacity: 0.72;
}

.progress-groups {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 0;
}

.progress-ellipsis {
  color: var(--text-muted);
  font-weight: 600;
  letter-spacing: 0.08em;
  line-height: 1;
}

.progress-group {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.group-title {
  color: var(--text);
  font-weight: 600;
}

.category-error .group-title {
  color: #ff8a8a;
}

.step-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.step-item {
  display: grid;
  grid-template-columns: 8px minmax(0, 1fr);
  gap: 8px;
  align-items: baseline;
  color: var(--text-muted);
}

.step-dot {
  width: 6px;
  height: 6px;
  border-radius: 999px;
  background: var(--accent);
}

.category-error .step-dot {
  background: #ff6b6b;
}

.category-error .step-detail {
  color: color-mix(in srgb, #ffb3b3 86%, var(--text));
}

.step-detail {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.step-body {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.tool-result {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 7px 9px;
  border: 1px solid color-mix(in srgb, var(--border) 72%, transparent);
  border-radius: 8px;
  background: color-mix(in srgb, var(--surface-elevated) 76%, transparent);
}

.tool-result.error {
  border-color: color-mix(in srgb, #ff6b6b 48%, var(--border));
  background: color-mix(in srgb, #ff6b6b 8%, var(--surface-elevated));
}

.tool-result-label {
  color: var(--text-muted);
  font-size: 11px;
}

.tool-result :deep(.markdown-renderer) {
  font-size: 12px;
  line-height: 1.55;
}

.tool-result :deep(pre) {
  max-height: 260px;
  overflow: auto;
}

.approval-card {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 10px;
  border: 1px solid color-mix(in srgb, var(--accent) 42%, var(--border));
  border-radius: 10px;
  background: color-mix(in srgb, var(--accent) 8%, var(--surface-elevated));
}

.approval-title {
  color: var(--text);
  font-weight: 600;
}

.approval-command {
  color: var(--text);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 12px;
  overflow-wrap: anywhere;
}

.approval-reason {
  color: var(--text-muted);
  font-size: 12px;
}

.approval-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}

.approval-button {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 4px 9px;
  background: var(--surface);
  color: var(--text);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}

.approval-button.primary {
  border-color: color-mix(in srgb, var(--accent) 70%, var(--border));
  background: color-mix(in srgb, var(--accent) 22%, var(--surface));
}

.approval-button:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.approval-status {
  color: var(--text-muted);
  font-size: 12px;
}

.approval-status.error {
  color: #ff8a8a;
}

</style>
