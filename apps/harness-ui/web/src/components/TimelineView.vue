<template>
  <div class="timeline">
    <div
      v-for="(ev, i) in events"
      :key="i"
      class="entry"
      :class="entryClass(ev)"
    >
      <div class="dot" />
      <div class="body">
        <span class="type">{{ label(ev) }}</span>
        <span class="detail">{{ detail(ev) }}</span>
        <span class="ts">{{ shortTs(ev.ts) }}</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { TimelineEvent } from "../types";

defineProps<{ events: TimelineEvent[] }>();

function entryClass(ev: TimelineEvent): string {
  switch (ev.type) {
    case "flow_completed": return "done";
    case "flow_failed": return "failed";
    case "step_dispatched":
    case "step_start": return "step";
    case "critique_completed":
    case "eval": return Number(ev.confidence ?? ev.score) >= 0.8 ? "pass" : "warn";
    case "flow_started": return "info";
    default: return "info";
  }
}

function label(ev: TimelineEvent): string {
  const map: Record<string, string> = {
    flow_started:        "flow 启动",
    flow_completed:      "flow 完成",
    flow_failed:         "flow 失败",
    step_dispatched:     `步骤 ${ev.stepId ?? ""}`,
    step_start:          `步骤 ${ev.step ?? ""}`,
    agent_call:          `agent 调用 ${ev.agent ?? ""}`,
    agent_done:          `agent 完成 ${ev.agent ?? ""}`,
    critique_completed:  "critique",
    eval:                "评分",
    retry:               "重试",
    step_done:           `步骤结束 ${ev.step ?? ""}`,
    approval_requested:  "等待审批",
    proposal_created:    "proposal",
  };
  return map[ev.type] ?? ev.type;
}

function detail(ev: TimelineEvent): string {
  if (ev.type === "critique_completed" || ev.type === "eval") {
    const score = (ev.confidence ?? ev.score) as number | undefined;
    const action = (ev.action ?? ev.nextAction ?? "") as string;
    return score != null ? `score=${score.toFixed(2)}${action ? ` → ${action}` : ""}` : "";
  }
  if (ev.type === "agent_done") return `${ev.duration_ms ?? ""}ms`;
  if (ev.type === "retry") return (ev.detail as string | undefined)?.slice(0, 80) ?? "";
  if (ev.type === "step_dispatched") return `agent: ${ev.agentId ?? ""}`;
  return "";
}

function shortTs(ts: string): string {
  return ts ? ts.slice(11, 19) : "";
}
</script>

<style scoped>
.timeline {
  padding: 8px 0;
  position: relative;
}

.entry {
  display: flex;
  gap: 10px;
  padding: 4px 16px;
  align-items: flex-start;
  position: relative;
}

.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--text-muted);
  flex-shrink: 0;
  margin-top: 5px;
}

.entry.step .dot    { background: var(--accent); }
.entry.pass .dot    { background: var(--success); }
.entry.warn .dot    { background: var(--warning); }
.entry.failed .dot  { background: var(--danger); }
.entry.done .dot    { background: var(--success); width: 10px; height: 10px; }

.body {
  display: flex;
  gap: 8px;
  align-items: baseline;
  flex-wrap: wrap;
  min-width: 0;
}

.type {
  font-size: 12px;
  font-weight: 500;
  color: var(--text);
}
.entry.step .type   { color: var(--accent); font-weight: 600; }
.entry.pass .type   { color: var(--success); }
.entry.warn .type   { color: var(--warning); }
.entry.failed .type { color: var(--danger); }

.detail {
  font-size: 11px;
  color: var(--text-muted);
  font-family: var(--font-mono);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 400px;
}

.ts {
  font-size: 10px;
  color: var(--text-muted);
  font-family: var(--font-mono);
  margin-left: auto;
  flex-shrink: 0;
}
</style>
