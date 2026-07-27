<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { TokenUsage } from "@/types";
import {
  buildContextSegments,
  buildRunTotalRows,
  contextRingTone,
  formatDurationMs,
  formatTokenCount,
  normalizeTokenUsage,
  type ContextUsageView,
} from "@/utils/context-usage";

const props = withDefaults(
  defineProps<{
    usage?: TokenUsage | null;
    locale?: string;
    /**
     * turn: text trigger ("统计") + this-turn metrics popover
     * turn-ring: ring trigger + this-turn metrics popover
     * context: context-window ring + occupancy panel (composer)
     */
    mode?: "turn" | "turn-ring" | "context";
  }>(),
  {
    mode: "context",
  },
);

const rootRef = ref<HTMLElement | null>(null);
const buttonRef = ref<HTMLButtonElement | null>(null);
const open = ref(false);
const popoverStyle = ref<Record<string, string>>({});
const POPOVER_WIDTH = 300;
const POPOVER_ATTR = "data-context-usage-popover";
/** Keep popover alive while pointer travels from ring → teleported panel. */
const HIDE_DELAY_MS = 220;
let hideTimer: ReturnType<typeof setTimeout> | undefined;

const view = computed(() => normalizeTokenUsage(props.usage));
const isZh = computed(() => (props.locale ?? navigator.language).toLowerCase().startsWith("zh"));
const tone = computed(() => contextRingTone(view.value?.percent ?? 0));
const hasContext = computed(() => (view.value?.contextMax ?? 0) > 0);
const isTurnMode = computed(
  () => props.mode === "turn" || props.mode === "turn-ring",
);
const isRingMode = computed(
  () => props.mode === "context" || props.mode === "turn-ring",
);
/** Text trigger ("统计") sitting beside the tool-progress log button. */
const isTextMode = computed(() => props.mode === "turn");
const statsLabel = computed(() => (isZh.value ? "统计" : "Stats"));

const hasTurnStats = computed(() => {
  const stats = view.value;
  if (!stats) return false;
  return (
    stats.totalTokens > 0 ||
    stats.durationMs > 0 ||
    stats.turns > 0 ||
    stats.toolUseCount > 0 ||
    stats.cacheReadTokens > 0 ||
    stats.cacheWriteTokens > 0 ||
    stats.reasoningTokens > 0
  );
});

const radius = 7;
const circumference = 2 * Math.PI * radius;
const dashOffset = computed(() => {
  const percent = view.value?.percent ?? 0;
  return circumference * (1 - Math.max(0, Math.min(100, percent)) / 100);
});

const contextSummary = computed(() => {
  const stats = view.value;
  if (!stats || !hasContext.value) return "—";
  return `~${formatTokenCount(stats.contextUsed)} / ${formatTokenCount(stats.contextMax)}`;
});

const title = computed(() => {
  if (isTurnMode.value) {
    return isZh.value ? "本轮用量" : "This turn usage";
  }
  if (!view.value || !hasContext.value) {
    return isZh.value ? "上下文窗口" : "Context window";
  }
  return isZh.value
    ? `上下文 ${view.value.percent}% · ${contextSummary.value}`
    : `Context ${view.value.percent}% · ${contextSummary.value}`;
});

interface DetailRow {
  label: string;
  value: string;
  muted?: boolean;
}

/** Always surface LLM usage fields for this turn (incl. cache / reasoning at 0). */
function buildRunRows(stats: ContextUsageView, zh: boolean): DetailRow[] {
  // Anthropic reports cache_* alongside input_tokens; OpenAI/DeepSeek inside it.
  const cacheNote = stats.cacheIncludedInInput
    ? zh
      ? "（含于输入）"
      : " (in input)"
    : zh
      ? "（不计入输入）"
      : " (outside input)";
  return [
    {
      label: zh ? "总耗时" : "Duration",
      value: formatDurationMs(stats.durationMs),
    },
    {
      label: zh ? "Token 总数" : "Total tokens",
      value: formatTokenCount(stats.totalTokens),
    },
    {
      label: zh ? "输入" : "Input",
      value: formatTokenCount(stats.inputTokens),
      muted: true,
    },
    {
      label: zh ? "输出" : "Output",
      value: formatTokenCount(stats.outputTokens),
      muted: true,
    },
    {
      label: `${zh ? "缓存读" : "Cache read"}${cacheNote}`,
      value: formatTokenCount(stats.cacheReadTokens),
      muted: true,
    },
    {
      label: `${zh ? "缓存写" : "Cache write"}${cacheNote}`,
      value: formatTokenCount(stats.cacheWriteTokens),
      muted: true,
    },
    {
      label: zh ? "推理" : "Reasoning",
      value: formatTokenCount(stats.reasoningTokens),
      muted: true,
    },
    {
      label: "TTFB",
      value: stats.ttfbMs != null ? formatDurationMs(stats.ttfbMs) : "—",
    },
    {
      label: "TTFT",
      value: stats.ttftMs != null ? formatDurationMs(stats.ttftMs) : "—",
    },
    {
      label: zh ? "轮次" : "Turns",
      value: String(stats.turns),
    },
    {
      label: zh ? "工具调用" : "Tool use",
      value: String(stats.toolUseCount),
    },
  ];
}

const runRows = computed(() => {
  const stats = view.value;
  if (!stats) return [];
  return buildRunRows(stats, isZh.value);
});

const contextSegments = computed(() => {
  const stats = view.value;
  if (!stats) return [];
  return buildContextSegments(stats);
});

const runTotalRows = computed(() => {
  const stats = view.value;
  if (!stats) return [];
  return buildRunTotalRows(stats);
});

const freeTokens = computed(() => {
  const stats = view.value;
  if (!stats || stats.contextMax <= 0) return 0;
  return Math.max(0, stats.contextMax - stats.contextUsed);
});

const segmentPercents = computed(() => {
  const stats = view.value;
  if (!stats || stats.contextMax <= 0) return [];
  return contextSegments.value.map((segment) => ({
    ...segment,
    widthPercent: Math.max(
      0,
      Math.min(100, (segment.tokens / stats.contextMax) * 100),
    ),
  }));
});

/** Fixed, viewport-clamped popover above the ring (Teleport → body). */
function updatePopoverPosition() {
  const button = buttonRef.value;
  if (!button) {
    popoverStyle.value = {};
    return;
  }
  const rect = button.getBoundingClientRect();
  const pad = 12;
  const gap = 8;
  const width = POPOVER_WIDTH;
  const left = Math.min(
    Math.max(pad, rect.left + rect.width / 2 - width / 2),
    Math.max(pad, window.innerWidth - width - pad),
  );
  const spaceAbove = rect.top - pad - gap;
  const openAbove = spaceAbove >= 160 || spaceAbove >= window.innerHeight - rect.bottom - pad - gap;

  if (openAbove) {
    popoverStyle.value = {
      position: "fixed",
      left: `${left}px`,
      bottom: `${Math.max(pad, window.innerHeight - rect.top + gap)}px`,
      width: `${width}px`,
      maxHeight: `${Math.max(120, spaceAbove)}px`,
      zIndex: "400",
    };
  } else {
    popoverStyle.value = {
      position: "fixed",
      left: `${left}px`,
      top: `${rect.bottom + gap}px`,
      width: `${width}px`,
      maxHeight: `${Math.max(120, window.innerHeight - rect.bottom - pad - gap)}px`,
      zIndex: "400",
    };
  }
}

function clearHideTimer() {
  if (hideTimer !== undefined) {
    clearTimeout(hideTimer);
    hideTimer = undefined;
  }
}

function showTooltip() {
  clearHideTimer();
  open.value = true;
  void nextTick(updatePopoverPosition);
}

/** Hover-open is for the rings only; the text trigger is click-to-open. */
function onPointerEnter() {
  if (isTextMode.value) return;
  showTooltip();
}

function scheduleHideTooltip() {
  clearHideTimer();
  hideTimer = setTimeout(() => {
    open.value = false;
    hideTimer = undefined;
  }, HIDE_DELAY_MS);
}

function onPointerLeave() {
  if (isTextMode.value) return;
  scheduleHideTooltip();
}

function hideTooltipNow() {
  clearHideTimer();
  open.value = false;
}

function toggleTooltip() {
  if (open.value) {
    hideTooltipNow();
    return;
  }
  showTooltip();
}

function onDocumentPointerDown(event: PointerEvent) {
  // Applies to every mode: the click-to-open text trigger needs this most,
  // since it has no hover-out to dismiss it.
  if (!open.value) return;
  const target = event.target;
  if (!(target instanceof Node)) return;
  if (rootRef.value?.contains(target)) return;
  if (target instanceof Element && target.closest(`[${POPOVER_ATTR}]`)) return;
  hideTooltipNow();
}

function onDocumentKeydown(event: KeyboardEvent) {
  if (!open.value || event.key !== "Escape") return;
  hideTooltipNow();
}

function onViewportChange() {
  if (open.value) updatePopoverPosition();
}

watch(open, (value) => {
  if (value) void nextTick(updatePopoverPosition);
});

onMounted(() => {
  document.addEventListener("pointerdown", onDocumentPointerDown, true);
  document.addEventListener("keydown", onDocumentKeydown, true);
  window.addEventListener("resize", onViewportChange);
  window.addEventListener("scroll", onViewportChange, true);
});

onBeforeUnmount(() => {
  clearHideTimer();
  document.removeEventListener("pointerdown", onDocumentPointerDown, true);
  document.removeEventListener("keydown", onDocumentKeydown, true);
  window.removeEventListener("resize", onViewportChange);
  window.removeEventListener("scroll", onViewportChange, true);
});
</script>

<template>
  <!-- Compact ring / text trigger -->
  <div
    v-if="(isRingMode || isTextMode) && view && (isTurnMode ? hasTurnStats : hasContext)"
    ref="rootRef"
    class="context-usage"
    :class="[`tone-${tone}`, { open, text: isTextMode }]"
    @mouseenter="onPointerEnter"
    @mouseleave="onPointerLeave"
  >
    <button
      v-if="isTextMode"
      ref="buttonRef"
      type="button"
      class="stats-button"
      :class="{ active: open }"
      :title="title"
      :aria-label="title"
      :aria-expanded="open"
      @click="toggleTooltip"
    >
      {{ statsLabel }}
    </button>
    <button
      v-else
      ref="buttonRef"
      type="button"
      class="ring-button"
      :title="title"
      :aria-label="title"
      :aria-expanded="open"
      @click="toggleTooltip"
    >
      <svg class="ring" viewBox="0 0 20 20" aria-hidden="true">
        <circle class="ring-track" cx="10" cy="10" r="7" />
        <circle
          class="ring-fill"
          cx="10"
          cy="10"
          r="7"
          :stroke-dasharray="circumference"
          :stroke-dashoffset="dashOffset"
        />
      </svg>
    </button>

    <Teleport to="body">
      <!-- Turn stats popover (tool-progress 统计 trigger / collapsed ring) -->
      <div
        v-if="open && isTurnMode"
        class="tooltip"
        role="tooltip"
        :style="popoverStyle"
        :data-context-usage-popover="true"
        @mouseenter="onPointerEnter"
        @mouseleave="onPointerLeave"
      >
        <div class="tooltip-title">{{ isZh ? "本轮统计" : "This turn stats" }}</div>
        <dl class="tooltip-rows">
          <div
            v-for="row in runRows"
            :key="row.label"
            class="tooltip-row"
            :class="{ muted: row.muted }"
          >
            <dt>{{ row.label }}</dt>
            <dd>{{ row.value }}</dd>
          </div>
        </dl>
      </div>

      <!-- Context Usage popover (input bar) -->
      <div
        v-else-if="open && mode === 'context' && view"
        class="tooltip context-tooltip"
        role="tooltip"
        :style="popoverStyle"
        :data-context-usage-popover="true"
        @mouseenter="showTooltip"
        @mouseleave="scheduleHideTooltip"
      >
        <div class="context-tooltip-header">
          <span class="tooltip-title">{{ isZh ? "上下文窗口" : "Context window" }}</span>
        </div>
        <p class="context-caption">
          {{
            isZh
              ? "最近一次请求的 prompt 占用（三段之和 = 已用）。接近上限时会压缩旧对话，或建议开新会话。"
              : "Prompt size of the latest request (segments sum to used). Near the limit, older chat gets compressed."
          }}
        </p>
        <div class="context-summary-row">
          <span>{{ view.percent }}% {{ isZh ? "已用" : "used" }}</span>
          <span>{{ contextSummary }} Tokens</span>
        </div>
        <div class="segment-bar" aria-hidden="true">
          <div
            v-for="segment in segmentPercents"
            :key="segment.id"
            class="segment-fill"
            :style="{ width: `${segment.widthPercent}%`, background: segment.color }"
          />
        </div>
        <ul class="segment-legend">
          <li v-for="segment in contextSegments" :key="segment.id">
            <span class="swatch" :style="{ background: segment.color }" />
            <span class="seg-label">{{ isZh ? segment.labelZh : segment.labelEn }}</span>
            <span class="seg-value">{{ formatTokenCount(segment.tokens) }}</span>
          </li>
          <li v-if="freeTokens > 0">
            <span class="swatch free" />
            <span class="seg-label">{{ isZh ? "剩余" : "Remaining" }}</span>
            <span class="seg-value">{{ formatTokenCount(freeTokens) }}</span>
          </li>
          <li v-if="contextSegments.length === 0" class="empty-seg">
            {{ isZh ? "暂无明细" : "No breakdown yet" }}
          </li>
        </ul>

        <template v-if="runTotalRows.length">
          <div class="run-totals-title">
            {{
              isZh
                ? `本轮累计（计费口径 · ${view.apiCalls || view.turns} 次请求）`
                : `This reply, cumulative (billing · ${view.apiCalls || view.turns} requests)`
            }}
          </div>
          <dl class="tooltip-rows run-totals">
            <div
              v-for="row in runTotalRows"
              :key="row.labelEn"
              class="tooltip-row muted"
            >
              <dt>{{ isZh ? row.labelZh : row.labelEn }}</dt>
              <dd>{{ row.value }}</dd>
            </div>
          </dl>
        </template>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.tooltip-title {
  margin-bottom: 8px;
  color: var(--text-muted);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.tooltip-rows {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 0;
}

.tooltip-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 16px;
  margin: 0 -6px;
  padding: 3px 6px;
  border-radius: 6px;
  font-size: 12px;
  transition: background 120ms ease;
}

.tooltip-row:hover {
  background: color-mix(
    in srgb,
    var(--surface-hover-solid, var(--surface-hover)) 65%,
    transparent
  );
}

.tooltip-row.muted {
  color: var(--text-muted);
  padding-left: 8px;
}

.tooltip-row dt {
  margin: 0;
  color: var(--text-muted);
  font-weight: 500;
}

.tooltip-row dd {
  margin: 0;
  font-variant-numeric: tabular-nums;
  text-align: right;
}

.context-usage {
  position: relative;
  display: inline-flex;
  align-items: center;
  flex-shrink: 0;
}

.ring-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: none;
  border-radius: 999px;
  padding: 0;
  background: transparent;
  color: inherit;
  cursor: pointer;
}

.ring-button:hover,
.context-usage.open .ring-button {
  background: color-mix(in srgb, var(--surface-hover) 70%, transparent);
}

/* Keep in sync with ToolProgressPanel's .header-log-button — they sit side by side. */
.stats-button {
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

.stats-button:hover,
.stats-button.active {
  color: var(--text);
  background: var(--surface-hover);
}

.ring {
  width: 16px;
  height: 16px;
  transform: rotate(-90deg);
}

.ring-track,
.ring-fill {
  fill: none;
  stroke-width: 2.4;
  stroke-linecap: round;
}

.ring-track {
  stroke: color-mix(in srgb, var(--text-muted) 28%, transparent);
}

.ring-fill {
  stroke: var(--accent, #6ee7b7);
  transition: stroke-dashoffset 180ms ease;
}

.tone-good .ring-fill {
  stroke: #6ee7b7;
}

.tone-warn .ring-fill {
  stroke: #fbbf24;
}

.tone-bad .ring-fill {
  stroke: #f97316;
}

.tone-critical .ring-fill {
  stroke: #f87171;
}

.tooltip {
  box-sizing: border-box;
  overflow: auto;
  padding: 12px 14px;
  border: 1px solid color-mix(in srgb, var(--border) 70%, transparent);
  border-radius: 12px;
  /* Solid surface: the glass tokens let the wallpaper show through the numbers. */
  background: var(--surface-elevated-solid, var(--surface-elevated));
  box-shadow: 0 12px 32px color-mix(in srgb, #000 40%, transparent);
  -webkit-backdrop-filter: none;
  backdrop-filter: none;
  color: var(--text);
  pointer-events: auto;
}

.context-tooltip {
  min-width: 280px;
}

.context-tooltip-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.context-caption {
  margin: 0 0 8px;
  color: var(--text-muted);
  font-size: 11px;
  line-height: 1.4;
}

.context-summary-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 10px;
  color: var(--text);
  font-size: 13px;
  font-variant-numeric: tabular-nums;
}

.segment-bar {
  display: flex;
  height: 8px;
  overflow: hidden;
  margin-bottom: 12px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--text-muted) 16%, transparent);
}

.segment-fill {
  height: 100%;
  min-width: 0;
}

.segment-legend {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.segment-legend li {
  display: grid;
  grid-template-columns: 10px 1fr auto;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}

.swatch {
  width: 8px;
  height: 8px;
  border-radius: 2px;
}

.swatch.free {
  background: color-mix(in srgb, var(--text-muted) 28%, transparent);
}

.run-totals-title {
  margin: 12px 0 6px;
  padding-top: 10px;
  border-top: 1px solid color-mix(in srgb, var(--border) 70%, transparent);
  color: var(--text-muted);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.run-totals {
  margin: 0;
}

.seg-label {
  color: var(--text-muted);
}

.seg-value {
  font-variant-numeric: tabular-nums;
  text-align: right;
}

.empty-seg {
  color: var(--text-muted);
}
</style>
