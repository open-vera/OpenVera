<template>
  <div class="run-detail">
    <!-- Header -->
    <div class="header">
      <div class="header-left">
        <span class="badge" :class="run.status">{{ statusLabel }}</span>
        <span class="run-id">{{ run.runId }}</span>
      </div>
      <div class="header-right">
        <span class="dur">{{ formatDuration(run.durationMs) }}</span>
        <span class="steps-summary">{{ run.completedSteps }}/{{ run.totalSteps }} 步完成</span>
      </div>
    </div>

    <div v-if="run.goal" class="goal">{{ run.goal }}</div>

    <!-- Live console for running flows -->
    <template v-if="run.status === 'running'">
      <LiveConsole :run-id="run.runId" class="console-section" />
    </template>

    <!-- Timeline + Steps for completed/failed -->
    <template v-else>
      <div class="tabs">
        <button :class="{ active: tab === 'steps' }" @click="tab = 'steps'">步骤详情</button>
        <button :class="{ active: tab === 'timeline' }" @click="tab = 'timeline'">事件时间轴</button>
      </div>

      <div class="tab-content">
        <!-- Steps -->
        <div v-if="tab === 'steps'" class="steps">
          <StepCard
            v-for="step in run.steps"
            :key="step.stepId"
            :run-id="run.runId"
            :step="step"
          />
        </div>

        <!-- Timeline -->
        <div v-else class="timeline-wrapper">
          <div v-if="loadingTimeline" class="loading">加载时间轴…</div>
          <TimelineView v-else :events="timelineEvents" />
        </div>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted } from "vue";
import { api } from "../api";
import type { RunSummary, TimelineEvent } from "../types";
import StepCard from "./StepCard.vue";
import TimelineView from "./TimelineView.vue";
import LiveConsole from "./LiveConsole.vue";

const props = defineProps<{ run: RunSummary }>();

const tab = ref<"steps" | "timeline">("steps");
const timelineEvents = ref<TimelineEvent[]>([]);
const loadingTimeline = ref(false);

const statusLabel = computed(() => {
  return { running: "运行中", completed: "完成", failed: "失败", paused: "暂停" }[props.run.status] ?? props.run.status;
});

async function loadTimeline() {
  if (loadingTimeline.value) return;
  loadingTimeline.value = true;
  try {
    timelineEvents.value = await api.runs.timeline(props.run.runId);
  } finally {
    loadingTimeline.value = false;
  }
}

watch(tab, (t) => { if (t === "timeline" && timelineEvents.value.length === 0) void loadTimeline(); });
watch(() => props.run.runId, () => { timelineEvents.value = []; tab.value = "steps"; });

function formatDuration(ms?: number) {
  if (!ms) return "";
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
}
</script>

<style scoped>
.run-detail {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}

.header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}

.header-left, .header-right {
  display: flex;
  align-items: center;
  gap: 10px;
}

.run-id { font-family: var(--font-mono); font-size: 12px; color: var(--text-muted); }
.dur, .steps-summary { font-size: 12px; color: var(--text-muted); }

.goal {
  padding: 8px 16px;
  font-size: 13px;
  color: var(--text);
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}

.badge {
  font-size: 11px;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 10px;
  text-transform: uppercase;
}
.badge.running   { background: var(--accent-dim); color: var(--accent); }
.badge.completed { background: var(--success-dim); color: var(--success); }
.badge.failed    { background: var(--danger-dim); color: var(--danger); }
.badge.paused    { background: var(--warning-dim); color: var(--warning); }

.console-section { flex: 1; }

.tabs {
  display: flex;
  gap: 2px;
  padding: 8px 16px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}
.tabs button {
  background: none;
  border: none;
  padding: 4px 12px;
  font-size: 13px;
  color: var(--text-muted);
  cursor: pointer;
  border-radius: 4px;
}
.tabs button:hover { background: var(--surface-2); }
.tabs button.active { color: var(--text); background: var(--surface-2); font-weight: 600; }

.tab-content { flex: 1; overflow-y: auto; }

.steps { padding: 12px 16px; }

.timeline-wrapper { padding: 4px 0; }

.loading { padding: 24px 16px; color: var(--text-muted); font-size: 13px; }
</style>
