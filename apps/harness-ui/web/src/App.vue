<template>
  <div class="app">
    <!-- Left sidebar -->
    <aside class="sidebar">
      <div class="sidebar-header">
        <span class="logo">Vera Harness</span>
        <button class="btn-new" @click="showRunner = !showRunner" title="启动新 Flow">+</button>
      </div>

      <!-- New run form (collapsible) -->
      <div v-if="showRunner" class="runner-wrap">
        <FlowRunner @spawned="onSpawned" />
      </div>

      <RunList
        :runs="runs"
        :loading="loading"
        :error="error"
        :selected="selectedRunId"
        @select="selectRun"
      />
    </aside>

    <!-- Main content -->
    <main class="main">
      <template v-if="selectedRun">
        <RunDetail :run="selectedRun" />
      </template>
      <div v-else class="empty-main">
        <p>选择左侧一条 run 查看详情</p>
        <p class="hint">或点击 <strong>+</strong> 启动一个新 Flow</p>
      </div>
    </main>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import { useRuns } from "./composables/useRuns";
import RunList from "./components/RunList.vue";
import RunDetail from "./components/RunDetail.vue";
import FlowRunner from "./components/FlowRunner.vue";

const { runs, loading, error, load, startPolling } = useRuns();

const selectedRunId = ref<string>();
const showRunner = ref(false);

const selectedRun = computed(() =>
  runs.value.find((r) => r.runId === selectedRunId.value)
);

function selectRun(id: string) {
  selectedRunId.value = id;
  showRunner.value = false;
}

function onSpawned(runId: string) {
  showRunner.value = false;
  // Start polling until the new run appears and finishes
  void load().then(() => {
    selectedRunId.value = runId;
    startPolling();
  });
}

onMounted(async () => {
  await load();
  // Auto-select the most recent run
  if (runs.value.length > 0) selectedRunId.value = runs.value[0]!.runId;
  startPolling();
});
</script>

<style>
/* ── CSS variables ─────────────────────────────────────────────────── */
:root {
  --bg:          #0d1117;
  --surface:     #161b22;
  --surface-2:   #1c2128;
  --surface-3:   #22272e;
  --border:      #30363d;
  --text:        #e6edf3;
  --text-muted:  #7d8590;
  --accent:      #58a6ff;
  --accent-dim:  #1f3d5c;
  --success:     #3fb950;
  --success-dim: #1a3626;
  --danger:      #f85149;
  --danger-dim:  #3d1a1a;
  --warning:     #d29922;
  --warning-dim: #3d2e0a;
  --font-mono:   "JetBrains Mono", "Fira Code", ui-monospace, monospace;
}

*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

html, body, #app { height: 100%; }

body {
  background: var(--bg);
  color: var(--text);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  font-size: 14px;
  line-height: 1.5;
}

::-webkit-scrollbar { width: 6px; height: 6px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }
::-webkit-scrollbar-thumb:hover { background: var(--text-muted); }
</style>

<style scoped>
.app {
  display: flex;
  height: 100%;
  overflow: hidden;
}

/* ── Sidebar ──────────────────────────────────────────────────────── */
.sidebar {
  width: 280px;
  flex-shrink: 0;
  background: var(--surface);
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.sidebar-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 16px;
  border-bottom: 1px solid var(--border);
}

.logo {
  font-size: 14px;
  font-weight: 700;
  color: var(--text);
  letter-spacing: 0.02em;
}

.btn-new {
  background: var(--accent);
  color: #fff;
  border: none;
  border-radius: 4px;
  width: 24px;
  height: 24px;
  font-size: 18px;
  line-height: 1;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
}
.btn-new:hover { opacity: 0.85; }

.runner-wrap {
  border-bottom: 1px solid var(--border);
  background: var(--surface-2);
}

/* ── Main ─────────────────────────────────────────────────────────── */
.main {
  flex: 1;
  min-width: 0;
  background: var(--surface);
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.empty-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  color: var(--text-muted);
  gap: 8px;
  font-size: 14px;
}
.empty-main .hint { font-size: 12px; }
</style>
