<template>
  <div class="step-card" :class="step.status">
    <div class="header" @click="open = !open">
      <span class="arrow">{{ open ? "▾" : "▸" }}</span>
      <span class="step-id">{{ step.stepId }}</span>
      <span class="agents">{{ step.agents.join(", ") }}</span>
      <span v-if="step.score != null" class="score" :class="scoreClass">
        {{ (step.score * 100).toFixed(0) }}
      </span>
      <span v-if="step.retries > 0" class="retries">×{{ step.retries + 1 }}</span>
      <span class="badge" :class="step.status">{{ statusLabel }}</span>
      <span class="dur">{{ formatDuration(step.durationMs) }}</span>
    </div>

    <div v-if="open" class="body">
      <!-- Critique summary -->
      <div v-if="step.critique" class="critique">
        <span class="critique-label">Critique</span>
        <span class="critique-score">{{ (step.critique.confidence * 100).toFixed(0) }}</span>
        <span v-if="step.critique.nextAction" class="critique-action">→ {{ step.critique.nextAction }}</span>
        <p v-if="step.critique.rationale" class="critique-rationale">{{ step.critique.rationale }}</p>
      </div>

      <!-- Agent interactions — lazy loaded -->
      <div v-if="detail" class="interactions">
        <div
          v-for="(ia, i) in detail.agents"
          :key="i"
          class="interaction"
        >
          <div class="ia-header">
            <span class="ia-agent">{{ ia.agent }}</span>
            <span v-if="ia.adapter" class="ia-adapter">{{ ia.adapter }}</span>
          </div>
          <details v-if="ia.prompt" class="ia-block">
            <summary>Prompt</summary>
            <pre class="ia-pre">{{ ia.prompt }}</pre>
          </details>
          <details v-if="ia.response" class="ia-block" open>
            <summary>Response</summary>
            <pre class="ia-pre">{{ ia.response }}</pre>
          </details>
        </div>
      </div>
      <button v-else class="load-btn" :disabled="loadingDetail" @click="loadDetail">
        {{ loadingDetail ? "加载中…" : "加载交互记录" }}
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from "vue";
import { api } from "../api";
import type { StepSummary, StepDetail } from "../types";

const props = defineProps<{ runId: string; step: StepSummary }>();

const open = ref(false);
const detail = ref<StepDetail>();
const loadingDetail = ref(false);

async function loadDetail() {
  loadingDetail.value = true;
  try {
    detail.value = await api.runs.step(props.runId, props.step.stepId);
  } finally {
    loadingDetail.value = false;
  }
}

const statusLabel = computed(() => {
  return { pending: "待执行", running: "运行中", done: "完成", failed: "失败" }[props.step.status] ?? props.step.status;
});

const scoreClass = computed(() => {
  const s = props.step.score ?? 0;
  if (s >= 0.8) return "good";
  if (s >= 0.6) return "warn";
  return "bad";
});

function formatDuration(ms?: number) {
  if (!ms) return "";
  const s = Math.floor(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
}
</script>

<style scoped>
.step-card {
  border: 1px solid var(--border);
  border-radius: 6px;
  overflow: hidden;
  margin-bottom: 6px;
}

.step-card.done   { border-left: 3px solid var(--success); }
.step-card.failed { border-left: 3px solid var(--danger); }
.step-card.running { border-left: 3px solid var(--accent); }

.header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  cursor: pointer;
  background: var(--surface-2);
  user-select: none;
}
.header:hover { background: var(--surface-3); }

.arrow { color: var(--text-muted); font-size: 10px; }
.step-id { font-family: var(--font-mono); font-size: 13px; font-weight: 600; }
.agents { font-size: 11px; color: var(--text-muted); }
.dur { font-size: 11px; color: var(--text-muted); margin-left: auto; }

.score {
  font-family: var(--font-mono);
  font-size: 12px;
  font-weight: 700;
  padding: 1px 5px;
  border-radius: 4px;
}
.score.good { color: var(--success); background: var(--success-dim); }
.score.warn { color: var(--warning); background: var(--warning-dim); }
.score.bad  { color: var(--danger); background: var(--danger-dim); }

.retries { font-size: 11px; color: var(--warning); }

.badge {
  font-size: 10px;
  font-weight: 600;
  padding: 1px 5px;
  border-radius: 10px;
  text-transform: uppercase;
}
.badge.done    { background: var(--success-dim); color: var(--success); }
.badge.failed  { background: var(--danger-dim); color: var(--danger); }
.badge.running { background: var(--accent-dim); color: var(--accent); }
.badge.pending { background: var(--surface-3); color: var(--text-muted); }

.body { padding: 12px; }

.critique {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  background: var(--surface-2);
  border-radius: 4px;
  margin-bottom: 10px;
  font-size: 12px;
}
.critique-label { color: var(--text-muted); }
.critique-score { font-weight: 700; font-family: var(--font-mono); }
.critique-action { color: var(--text-muted); }
.critique-rationale {
  width: 100%;
  margin: 6px 0 0;
  font-size: 11px;
  color: var(--text-muted);
  line-height: 1.5;
}

.interaction { margin-bottom: 12px; }

.ia-header {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-bottom: 4px;
}
.ia-agent { font-weight: 600; font-size: 12px; }
.ia-adapter { font-size: 11px; color: var(--text-muted); }

.ia-block { margin-bottom: 4px; }
.ia-block summary {
  cursor: pointer;
  font-size: 11px;
  color: var(--text-muted);
  user-select: none;
  padding: 2px 0;
}
.ia-pre {
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 1.5;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 8px;
  overflow-x: auto;
  max-height: 300px;
  overflow-y: auto;
  white-space: pre-wrap;
  word-break: break-word;
  margin: 4px 0 0;
}

.load-btn {
  font-size: 12px;
  padding: 4px 10px;
  border: 1px solid var(--border);
  background: var(--surface-2);
  color: var(--text);
  border-radius: 4px;
  cursor: pointer;
}
.load-btn:hover { background: var(--surface-3); }
.load-btn:disabled { opacity: 0.5; cursor: not-allowed; }
</style>
