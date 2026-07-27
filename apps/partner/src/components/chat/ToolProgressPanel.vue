<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { approveAgentTool } from "@/bridge/agent";
import type { TokenUsage, ToolCall, ToolResult } from "@/types";
import { measureSync } from "@/perf";
import {
  compactToolProgress,
  foldRepeatedLines,
  formatStepDetail,
  groupToolProgress,
  inputCwd,
  isShellProgressStep,
  isVisibleToolProgressStep,
  summarizeResultOutput,
  summarizeToolCall,
  TOOL_RESULT_COMPACT_PREVIEW_MAX_CHARS,
  TOOL_RESULT_MARKDOWN_MAX_CHARS,
  TOOL_RESULT_PREVIEW_MAX_CHARS,
  truncateDisplayText,
  type ToolProgressStep,
} from "@/utils/tool-progress";
import ContextUsageRing from "./ContextUsageRing.vue";
import MarkdownRenderer from "./MarkdownRenderer.vue";

const props = defineProps<{
  toolCalls: ToolCall[];
  toolResults?: ToolResult[];
  running?: boolean;
  showLogs?: boolean;
  /** LLM response usage for this turn (from sidecar usage events). */
  usage?: TokenUsage | null;
  /**
   * live: newest step only, results as a one-line summary (agent still working)
   * history: full step list with expandable results
   */
  variant?: "live" | "history";
}>();

const emit = defineEmits<{
  "open-logs": [];
}>();

const expanded = ref(false);
const approvalStates = ref<Record<string, "pending" | "approved" | "denied" | "error">>({});
const expandedResultIds = ref<Set<string>>(new Set());

const RESULT_COLLAPSED_MAX_HEIGHT = 160;
const RESULT_COMPACT_MAX_HEIGHT = 96;

const isLive = computed(() => props.variant === "live" && !expanded.value);
const locale = computed(() => navigator.language);
const steps = computed(() =>
  props.toolCalls.map((toolCall) => summarizeToolCall(toolCall, locale.value)),
);
const progressSteps = computed(() => steps.value.filter(isVisibleToolProgressStep));
const groups = computed(() => groupToolProgress(progressSteps.value));
const visibleGroups = computed(() => {
  if (expanded.value) return groups.value;
  // Live: just the step in flight. Otherwise a small preview of the tail.
  if (isLive.value) return compactToolProgress(groups.value, 1, 1);
  return compactToolProgress(groups.value);
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
  if (isLive.value) {
    return isZh.value ? `执行中 · ${totalSteps.value} 步` : `Running · ${totalSteps.value} steps`;
  }
  return isZh.value
    ? `已执行 ${totalSteps.value} 个步骤`
    : `${totalSteps.value} steps completed`;
});
const toggleText = computed(() => {
  if (isZh.value) {
    if (expanded.value) return "收起";
    return isLive.value ? "详情" : "展开全部";
  }
  if (expanded.value) return "Collapse";
  return isLive.value ? "Details" : "Expand all";
});
const logsText = computed(() => (isZh.value ? "日志" : "Logs"));

function toggleExpanded() {
  measureSync(
    expanded.value ? "toolProgress.collapse" : "toolProgress.expandAll",
    () => {
      expanded.value = !expanded.value;
    },
    {
      warnMs: 32,
      errorMs: 200,
      meta: { stepCount: totalSteps.value },
    },
  );
}

function onOpenLogs() {
  emit("open-logs");
}

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

function shellCwd(step: ToolProgressStep): string {
  return inputCwd(step.rawInput) ?? "";
}

function stepDetailText(step: ToolProgressStep): string {
  return formatStepDetail(step, expanded.value ? "full" : "compact");
}

function usesMonoDetail(step: ToolProgressStep): boolean {
  return isShellProgressStep(step) || Boolean(step.rawInput.cmd || step.rawInput.command);
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

function approvalAllowDir(step: ToolProgressStep): string {
  return rawString(step.rawInput, "allowDir");
}

function approvalState(step: ToolProgressStep) {
  return approvalStates.value[approvalCallId(step)] ?? "pending";
}

function toolResult(step: ToolProgressStep): ToolResult | undefined {
  return resultByCallId.value.get(step.id);
}

function resultText(result: ToolResult): string {
  const text = foldRepeatedLines(result.output.trim());
  if (!text) return result.isError ? "命令执行失败，无输出" : "命令执行成功，无输出";
  return text;
}

/** Live view: never mount a full output block, just one summary line. */
function liveResultSummary(result: ToolResult): string {
  return summarizeResultOutput(result.output, result.isError, locale.value);
}

function displayResultText(stepId: string, result: ToolResult): string {
  const full = resultText(result);
  if (isResultExpanded(stepId)) {
    // Still hard-cap markdown/plain mount size so expand-all cannot freeze the UI.
    return truncateDisplayText(full, TOOL_RESULT_MARKDOWN_MAX_CHARS).text;
  }
  if (!expanded.value) {
    return truncateDisplayText(full, TOOL_RESULT_COMPACT_PREVIEW_MAX_CHARS).text;
  }
  return truncateDisplayText(full, TOOL_RESULT_PREVIEW_MAX_CHARS).text;
}

function resultPreviewMaxHeight(stepId: string): number | undefined {
  if (isResultExpanded(stepId)) return undefined;
  return expanded.value ? RESULT_COLLAPSED_MAX_HEIGHT : RESULT_COMPACT_MAX_HEIGHT;
}

function shouldRenderResultMarkdown(step: ToolProgressStep, result: ToolResult): boolean {
  if (isTerminalOutput(step)) return false;
  if (!isResultExpanded(step.id)) return false;
  return resultText(result).length <= TOOL_RESULT_MARKDOWN_MAX_CHARS;
}

function isTerminalOutput(step: ToolProgressStep): boolean {
  const name = step.rawName.toLowerCase();
  return name === "bash" || name.includes("shell") || name.includes("exec");
}

function isResultExpanded(stepId: string): boolean {
  return expandedResultIds.value.has(stepId);
}

function toggleResultExpand(stepId: string): void {
  const next = new Set(expandedResultIds.value);
  if (next.has(stepId)) {
    next.delete(stepId);
  } else {
    next.add(stepId);
  }
  expandedResultIds.value = next;
}

function onResultClick(stepId: string, event: MouseEvent): void {
  const target = event.target as HTMLElement | null;
  if (target?.closest("a")) return;
  if (isResultExpanded(stepId) && target?.closest(".tool-result-content")) return;
  const selection = window.getSelection()?.toString().trim();
  if (selection) return;
  toggleResultExpand(stepId);
}

function resultExpandHint(stepId: string, result: ToolResult): string | null {
  if (isResultExpanded(stepId)) {
    return isZh.value ? "点击收起" : "Click to collapse";
  }
  if (resultText(result).length < 240) return null;
  return isZh.value ? "点击展开全部" : "Click to expand";
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
      expandedResultIds.value = new Set();
    }
  },
);
</script>

<template>
  <section v-if="hasVisibleSteps" class="tool-progress" :class="{ completed: !running, expanded }">
    <div class="tool-progress-header">
      <div class="header-left">
        <button type="button" class="header-title-button" @click="toggleExpanded">
          <span class="header-title">{{ headerText }}</span>
        </button>
        <button
          v-if="showLogs"
          type="button"
          class="header-log-button"
          @click="onOpenLogs"
        >
          {{ logsText }}
        </button>
        <ContextUsageRing mode="turn" :usage="usage" :locale="locale" />
      </div>
      <div class="header-right">
        <button type="button" class="header-meta" @click="toggleExpanded">
          {{ toggleText }}
        </button>
      </div>
    </div>

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
        <div v-if="expanded" class="group-title-row">
          <div class="group-title">{{ group.title }}</div>
        </div>
        <ol class="step-list">
          <li v-for="step in group.steps" :key="step.id" class="step-item">
            <span class="step-dot" aria-hidden="true" />
            <span v-if="!isApprovalStep(step)" class="step-body">
              <pre
                class="step-detail"
                :class="{
                  collapsed: !expanded,
                  mono: usesMonoDetail(step),
                }"
              >{{ stepDetailText(step) }}</pre>
              <span
                v-if="expanded && isShellProgressStep(step) && shellCwd(step)"
                class="step-cwd"
              >
                {{ isZh ? "目录" : "cwd" }}：{{ shellCwd(step) }}
              </span>
              <button
                v-if="toolResult(step) && isLive"
                type="button"
                class="tool-result live"
                :class="{ error: toolResult(step)?.isError }"
                @click="toggleExpanded"
              >
                <span class="tool-result-label">{{ resultLabel(toolResult(step)!) }}</span>
                <span class="tool-result-line">{{ liveResultSummary(toolResult(step)!) }}</span>
              </button>
              <button
                v-else-if="toolResult(step)"
                type="button"
                class="tool-result"
                :class="{
                  error: toolResult(step)?.isError,
                  'result-expanded': isResultExpanded(step.id),
                  compact: !expanded,
                }"
                @click="onResultClick(step.id, $event)"
              >
                <span class="tool-result-label">
                  {{ resultLabel(toolResult(step)!) }}
                  <span
                    v-if="resultExpandHint(step.id, toolResult(step)!)"
                    class="tool-result-hint"
                  >
                    {{ resultExpandHint(step.id, toolResult(step)!) }}
                  </span>
                </span>
                <div
                  class="tool-result-content"
                  :style="
                    resultPreviewMaxHeight(step.id) === undefined
                      ? undefined
                      : { maxHeight: `${resultPreviewMaxHeight(step.id)}px` }
                  "
                >
                  <MarkdownRenderer
                    v-if="shouldRenderResultMarkdown(step, toolResult(step)!)"
                    :content="displayResultText(step.id, toolResult(step)!)"
                  />
                  <pre
                    v-else
                    class="tool-result-output"
                  >{{ displayResultText(step.id, toolResult(step)!) }}</pre>
                </div>
              </button>
            </span>
            <span
              v-else
              class="approval-card"
              :class="{ pending: approvalState(step) === 'pending' }"
            >
              <span class="approval-title">{{ step.detail }}</span>
              <span v-if="approvalCommand(step)" class="approval-command">
                {{ approvalCommand(step) }}
              </span>
              <span v-else-if="approvalAllowDir(step)" class="approval-command">
                {{ approvalAllowDir(step) }}
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
  width: var(--chat-assistant-width, min(92%, 900px));
  max-width: var(--chat-assistant-width, min(92%, 900px));
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
  margin: 0;
  padding: 6px 8px;
  border: 1px solid transparent;
  border-radius: 8px;
  color: inherit;
  transition:
    background 140ms ease,
    border-color 140ms ease,
    opacity 140ms ease,
    box-shadow 140ms ease;
}

.completed .tool-progress-header {
  opacity: 0.82;
}

.tool-progress-header:hover {
  opacity: 1;
  border-color: color-mix(in srgb, var(--border) 70%, transparent);
  background: color-mix(
    in srgb,
    var(--surface-hover-solid, var(--surface-hover)) 72%,
    transparent
  );
  cursor: pointer;
}

.tool-progress.expanded .tool-progress-header {
  position: sticky;
  top: 8px;
  z-index: 2;
  margin-bottom: 10px;
  border-color: color-mix(in srgb, var(--border) 62%, transparent);
  background: color-mix(in srgb, var(--surface) 92%, transparent);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.14);
  backdrop-filter: blur(8px);
}

.tool-progress.expanded .tool-progress-header:hover {
  border-color: color-mix(in srgb, var(--accent) 42%, var(--border));
  background: color-mix(
    in srgb,
    var(--accent) 10%,
    var(--surface-elevated-solid, var(--surface-elevated))
  );
  box-shadow: 0 6px 16px rgba(0, 0, 0, 0.18);
}

.header-left {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.header-title-button,
.header-meta {
  border: none;
  padding: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
}

.header-title-button {
  min-width: 0;
  text-align: left;
}

.header-title {
  font-weight: 600;
}

.completed .header-title {
  font-weight: 500;
}

.has-error .header-title {
  color: var(--danger-muted);
}

.header-log-button {
  flex-shrink: 0;
  height: 22px;
  border: none;
  border-radius: 999px;
  padding: 0 8px;
  background: color-mix(in srgb, var(--surface-hover) 68%, transparent);
  color: var(--text-muted);
  font: inherit;
  font-size: 11px;
  cursor: pointer;
}

.header-log-button:hover {
  color: var(--text);
  background: var(--surface-hover);
}

.header-right {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
}

.header-meta:hover {
  color: var(--text);
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

.group-title-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-width: 0;
}

.group-title {
  min-width: 0;
  color: var(--text);
  font-weight: 600;
}

.category-error .group-title {
  color: var(--danger-muted);
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
  background: var(--danger);
}

.category-error .step-detail {
  color: color-mix(in srgb, var(--danger-muted) 86%, var(--text));
}

.step-detail {
  margin: 0;
  min-width: 0;
  color: inherit;
  font: inherit;
  font-size: 13px;
  line-height: 1.45;
}

.step-detail.mono {
  color: var(--text);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 12px;
}

.step-detail.collapsed {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.step-detail:not(.collapsed) {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.step-cwd {
  color: var(--text-muted);
  font-size: 11px;
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
  text-align: left;
  cursor: pointer;
}

.tool-result.compact {
  padding: 6px 8px;
  gap: 2px;
}

/* Live view: one row, never a scrollable output block. */
.tool-result.live {
  flex-direction: row;
  align-items: baseline;
  gap: 8px;
  padding: 4px 8px;
}

.tool-result.live .tool-result-line {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, monospace);
  font-size: 12px;
  color: var(--text-secondary, var(--text-muted));
}

.tool-result.compact .tool-result-output {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 4;
  line-clamp: 4;
  white-space: pre-wrap;
  overflow: hidden;
}

.tool-result:hover {
  border-color: color-mix(in srgb, var(--accent) 34%, var(--border));
}

.tool-result.result-expanded {
  cursor: default;
}

.tool-result.error {
  border-color: color-mix(in srgb, var(--danger) 48%, var(--border));
  background: color-mix(in srgb, var(--danger) 8%, var(--surface-elevated));
}

.tool-result-label {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  color: var(--text-muted);
  font-size: 11px;
}

.tool-result-hint {
  color: var(--accent);
  font-size: 11px;
  white-space: nowrap;
}

.tool-result-content {
  min-width: 0;
  overflow: auto;
  position: relative;
}

.tool-result:not(.result-expanded) .tool-result-content::after {
  content: "";
  position: sticky;
  bottom: 0;
  display: block;
  height: 18px;
  margin-top: -18px;
  background: linear-gradient(
    to bottom,
    transparent,
    color-mix(in srgb, var(--surface-elevated) 88%, transparent)
  );
  pointer-events: none;
}

.tool-result.result-expanded .tool-result-content {
  max-height: min(70vh, 960px);
}

.tool-result-output {
  margin: 0;
  color: var(--text);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 12px;
  line-height: 1.5;
  white-space: pre;
  overflow-wrap: normal;
}

.tool-result :deep(.markdown-renderer) {
  font-size: 12px;
  line-height: 1.55;
}

.tool-result :deep(pre) {
  margin: 0;
  max-height: none;
  overflow: visible;
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

.approval-card.pending {
  position: sticky;
  bottom: 10px;
  z-index: 3;
  box-shadow:
    0 12px 28px rgba(0, 0, 0, 0.28),
    inset 0 1px 0 color-mix(in srgb, #fff 6%, transparent);
  backdrop-filter: blur(8px);
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
  color: var(--danger-muted);
}

</style>
