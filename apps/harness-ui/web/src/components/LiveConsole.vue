<template>
  <div class="live-console">
    <div class="console-toolbar">
      <span class="label">Live — {{ runId }}</span>
      <span class="status" :class="done ? 'done' : 'live'">
        {{ done ? "已结束" : "● 运行中" }}
      </span>
    </div>
    <div ref="logEl" class="log">
      <div
        v-for="(ev, i) in events"
        :key="i"
        class="log-line"
        :class="lineClass(ev)"
      >
        <span class="log-ts">{{ ev.ts.slice(11, 19) }}</span>
        <span class="log-type">{{ ev.type }}</span>
        <span class="log-detail">{{ logDetail(ev) }}</span>
      </div>
      <div v-if="!done" class="log-line cursor">
        <span class="log-ts">…</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, nextTick } from "vue";
import { useStream } from "../composables/useStream";
import type { TimelineEvent } from "../types";

const props = defineProps<{ runId: string }>();

const { events, done } = useStream(props.runId);
const logEl = ref<HTMLElement>();

watch(events, async () => {
  await nextTick();
  if (logEl.value) logEl.value.scrollTop = logEl.value.scrollHeight;
}, { deep: true });

function lineClass(ev: TimelineEvent): string {
  if (ev.type === "flow_completed") return "success";
  if (ev.type === "flow_failed") return "error";
  if (ev.type === "critique_completed" || ev.type === "eval") {
    return Number(ev.confidence ?? ev.score) >= 0.8 ? "pass" : "warn";
  }
  if (ev.type.startsWith("step_")) return "step";
  return "";
}

function logDetail(ev: TimelineEvent): string {
  const parts: string[] = [];
  if (ev.stepId) parts.push(`step=${ev.stepId}`);
  if (ev.step) parts.push(`step=${ev.step}`);
  if (ev.agentId) parts.push(`agent=${ev.agentId}`);
  if (ev.agent) parts.push(`agent=${ev.agent}`);
  if (ev.confidence != null) parts.push(`score=${(ev.confidence as number).toFixed(2)}`);
  if (ev.score != null) parts.push(`score=${(ev.score as number).toFixed(2)}`);
  if (ev.duration_ms != null) parts.push(`${ev.duration_ms}ms`);
  if (ev.action && ev.type === "eval") parts.push(`→ ${ev.action}`);
  return parts.join("  ");
}
</script>

<style scoped>
.live-console {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--surface);
}

.console-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 16px;
  border-bottom: 1px solid var(--border);
  background: var(--surface-2);
}

.label {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text-muted);
}

.status {
  font-size: 11px;
  font-weight: 600;
}
.status.live { color: var(--success); }
.status.done { color: var(--text-muted); }

.log {
  flex: 1;
  overflow-y: auto;
  padding: 8px 0;
  font-family: var(--font-mono);
  font-size: 12px;
}

.log-line {
  display: flex;
  gap: 10px;
  padding: 2px 16px;
  line-height: 1.6;
  color: var(--text);
}
.log-line:hover { background: var(--surface-2); }
.log-line.success { color: var(--success); }
.log-line.error   { color: var(--danger); }
.log-line.warn    { color: var(--warning); }
.log-line.pass    { color: var(--success); }
.log-line.step    { color: var(--accent); }
.log-line.cursor  { color: var(--text-muted); }

.log-ts   { color: var(--text-muted); flex-shrink: 0; width: 60px; }
.log-type { flex-shrink: 0; width: 160px; }
.log-detail { color: var(--text-muted); }
</style>
