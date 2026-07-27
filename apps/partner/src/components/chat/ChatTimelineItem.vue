<script setup lang="ts">
import type { TokenUsage } from "@/types";
import type { ChatDisplayItem } from "@/utils/chat-timeline";
import MessageBubble from "./MessageBubble.vue";
import ToolProgressPanel from "./ToolProgressPanel.vue";
import TurnChangesPanel from "./TurnChangesPanel.vue";

const props = defineProps<{
  item: ChatDisplayItem;
  /** Tool blocks only: this block is the one currently executing. */
  running?: boolean;
  usage?: TokenUsage | null;
  /** Tool blocks only: compact single-step view while the agent works. */
  variant?: "live" | "history";
}>();

const emit = defineEmits<{
  "promote-queued": [messageId: string];
  "run-queued-now": [messageId: string];
  "open-logs": [];
}>();

/** Narrow helpers keep the template free of type assertions. */
function asMessageItem(item: ChatDisplayItem) {
  return item.type === "message" ? item : null;
}
function asToolItem(item: ChatDisplayItem) {
  return item.type === "tool-progress" ? item : null;
}
function asChangesItem(item: ChatDisplayItem) {
  return item.type === "turn-changes" ? item : null;
}
</script>

<template>
  <div v-if="props.item.type === 'time'" class="time-separator">
    {{ props.item.label }}
  </div>
  <MessageBubble
    v-else-if="asMessageItem(props.item)"
    :message="asMessageItem(props.item)!.message"
    @promote-queued="emit('promote-queued', $event)"
    @run-queued-now="emit('run-queued-now', $event)"
  />
  <ToolProgressPanel
    v-else-if="asToolItem(props.item)"
    :tool-calls="asToolItem(props.item)!.toolCalls"
    :tool-results="asToolItem(props.item)!.toolResults"
    :running="props.running"
    :variant="props.variant"
    :show-logs="true"
    :usage="props.usage ?? null"
    @open-logs="emit('open-logs')"
  />
  <TurnChangesPanel
    v-else-if="asChangesItem(props.item)"
    :changes="asChangesItem(props.item)!.changes"
  />
</template>

<style scoped>
/* Mirrors ChatPanel's separator pill so a standalone item looks identical. */
.time-separator {
  align-self: center;
  max-width: 80%;
  margin: 4px 0;
  padding: 2px 8px;
  border-radius: 999px;
  color: var(--text-muted);
  background: color-mix(in srgb, var(--surface) 66%, transparent);
  font-size: 12px;
  line-height: 1.6;
}
</style>
