<template>
  <article class="card">
    <h3>Timeline</h3>
    <div v-for="event in mergedEvents.slice().reverse()" :key="eventKey(event)" class="list-item">
      <span class="mono muted">{{ String(event.ts ?? "") }}</span>
      <span>{{ String(event.type ?? "event") }}</span>
    </div>
    <p v-if="mergedEvents.length === 0" class="muted">暂无事件</p>
  </article>
</template>

<script setup lang="ts">
import { computed } from "vue";
import type { RunDetail, TimelineEvent } from "../../api";

const props = defineProps<{
  run: RunDetail;
  streamEvents: TimelineEvent[];
}>();

const mergedEvents = computed(() => [...props.run.timeline, ...props.streamEvents]);

function eventKey(event: TimelineEvent): string {
  return `${String(event.ts)}-${String(event.type)}-${JSON.stringify(event).slice(0, 40)}`;
}
</script>

<style scoped>
.list-item {
  display: flex;
  gap: 8px;
  border-bottom: 1px solid var(--border);
  padding: 8px 0;
}
</style>
