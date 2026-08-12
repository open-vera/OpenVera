<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { TokenUsage } from "@/types";
import { turnDurationMs, type ChatTurnEntry } from "@/utils/chat-timeline";
import { formatDurationMs } from "@/utils/context-usage";
import ChatTimelineItem from "./ChatTimelineItem.vue";
import ContextUsageRing from "./ContextUsageRing.vue";

const props = defineProps<{
  turn: ChatTurnEntry;
  /** The agent is still working on this turn. */
  running?: boolean;
  usage?: TokenUsage | null;
  locale?: string;
}>();

const emit = defineEmits<{
  "promote-queued": [messageId: string];
  "run-queued-now": [messageId: string];
  "open-logs": [];
}>();

/**
 * While running we show only the newest segment (thinking → tool → result);
 * once finished the whole process folds behind the header. Either way the user
 * can open it, and their choice sticks across the running → finished flip.
 */
const userExpanded = ref<boolean | null>(null);
const expanded = computed(() => userExpanded.value ?? false);

watch(
  () => props.running,
  (running, wasRunning) => {
    // A new run reuses the component; drop a stale manual expand.
    if (running && !wasRunning) userExpanded.value = null;
  }
);

const isZh = computed(() =>
  (props.locale ?? navigator.language).toLowerCase().startsWith("zh")
);

const processItems = computed(() => props.turn.processItems);
const turnUsage = computed(() => {
  for (let index = processItems.value.length - 1; index >= 0; index -= 1) {
    const item = processItems.value[index];
    if (item?.type === "tool-progress" && item.usage) return item.usage;
  }
  return props.usage ?? null;
});
const liveItem = computed(
  () => processItems.value[processItems.value.length - 1] ?? null
);
const visibleItems = computed(() => {
  if (expanded.value) return processItems.value;
  if (!props.running) return [];
  return liveItem.value ? [liveItem.value] : [];
});
const hiddenCount = computed(() =>
  Math.max(0, processItems.value.length - visibleItems.value.length)
);

const durationLabel = computed(() => {
  const explicit = turnDurationMs(props.turn);
  const fromUsage = turnUsage.value?.duration_ms;
  const ms = explicit ?? (typeof fromUsage === "number" ? fromUsage : null);
  return ms === null ? null : formatDurationMs(ms);
});

const headerText = computed(() => {
  if (props.running) {
    return isZh.value ? "处理中…" : "Working…";
  }
  const duration = durationLabel.value;
  if (isZh.value) return duration ? `已处理 ${duration}` : "已处理";
  return duration ? `Worked for ${duration}` : "Done";
});

const hiddenText = computed(() => {
  if (!hiddenCount.value) return null;
  return isZh.value
    ? `展开前 ${hiddenCount.value} 段过程`
    : `Show ${hiddenCount.value} earlier steps`;
});

const isLastItem = (index: number) => index === visibleItems.value.length - 1;

function toggle() {
  userExpanded.value = !expanded.value;
}

function onOpenLogs() {
  emit("open-logs");
}
</script>

<template>
  <section class="turn" :class="{ running: props.running, expanded }">
    <div v-if="processItems.length" class="turn-summary">
      <button
        type="button"
        class="turn-header"
        :aria-expanded="expanded"
        @click="toggle"
      >
        <span v-if="props.running" class="turn-dot" aria-hidden="true" />
        <span class="turn-title">{{ headerText }}</span>
        <span class="turn-chevron" aria-hidden="true">{{
          expanded ? "⌄" : "›"
        }}</span>
      </button>
      <div class="turn-actions">
        <button type="button" class="turn-action" @click="onOpenLogs">
          {{ isZh ? "日志" : "Logs" }}
        </button>
        <ContextUsageRing mode="turn" :usage="turnUsage" :locale="locale" />
      </div>
    </div>

    <div v-if="visibleItems.length" class="turn-body">
      <ChatTimelineItem
        v-for="(item, index) in visibleItems"
        :key="item.key"
        :item="item"
        :running="props.running && isLastItem(index)"
        :variant="props.running && !expanded ? 'live' : 'history'"
        :usage="turnUsage"
        @promote-queued="emit('promote-queued', $event)"
        @run-queued-now="emit('run-queued-now', $event)"
        @open-logs="emit('open-logs')"
      />
      <button v-if="hiddenText" type="button" class="turn-more" @click="toggle">
        {{ hiddenText }}
      </button>
    </div>

    <ChatTimelineItem v-if="props.turn.changes" :item="props.turn.changes" />
    <ChatTimelineItem
      v-if="props.turn.finalMessage"
      :item="{
        type: 'message',
        key: props.turn.finalMessage.id,
        turnId: props.turn.turnId,
        message: props.turn.finalMessage,
      }"
      @promote-queued="emit('promote-queued', $event)"
      @run-queued-now="emit('run-queued-now', $event)"
    />
  </section>
</template>

<style scoped>
.turn {
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: 100%;
}

.turn-header {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  align-self: flex-start;
  border: 1px solid transparent;
  border-radius: 8px;
  padding: 4px 8px;
  background: transparent;
  color: var(--text-muted);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
  transition:
    background 140ms ease,
    border-color 140ms ease,
    color 140ms ease;
}

.turn-summary {
  display: flex;
  align-items: center;
  align-self: flex-start;
  gap: 6px;
}

.turn-actions {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.turn-action {
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

.turn-action:hover {
  color: var(--text);
  background: var(--surface-hover);
}

.turn-header:hover {
  color: var(--text);
  border-color: color-mix(in srgb, var(--border) 70%, transparent);
  background: color-mix(
    in srgb,
    var(--surface-hover-solid, var(--surface-hover)) 60%,
    transparent
  );
}

.turn-chevron {
  font-size: 11px;
  opacity: 0.7;
}

.turn-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent);
  animation: turn-pulse 1.2s ease-in-out infinite;
}

@keyframes turn-pulse {
  0%,
  100% {
    opacity: 0.35;
  }
  50% {
    opacity: 1;
  }
}

.turn-body {
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: 100%;
}

.turn-more {
  align-self: flex-start;
  border: none;
  border-radius: 6px;
  padding: 2px 6px;
  background: transparent;
  color: var(--text-muted);
  font: inherit;
  font-size: 11px;
  cursor: pointer;
}

.turn-more:hover {
  color: var(--text);
}
</style>
