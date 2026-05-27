<template>
  <div class="app-container">
    <header class="header">
      <h1>Vera Core UI</h1>
      <div class="run-selector">
        <label>选择运行:</label>
        <select v-model="selectedRunId" @change="handleRunChange" :disabled="loading">
          <option value="">Select a run</option>
          <option v-for="run in runs" :key="run.runId" :value="run.runId">
            {{ run.runId }} ({{ run.status }}) - {{ new Date(run.startedAt).toLocaleString() }}
          </option>
        </select>
        <span v-if="loading" class="loading-indicator">🔄</span>
      </div>
    </header>
    <nav class="tabs">
      <router-link :to="`/runs/${selectedRunId}/memory`" class="tab" :class="{ active: $route.name === 'run-memory' }">Memory</router-link>
      <router-link :to="`/runs/${selectedRunId}/checkpoints`" class="tab" :class="{ active: $route.name === 'run-checkpoints' }">Checkpoints</router-link>
      <router-link :to="`/runs/${selectedRunId}/subagents`" class="tab" :class="{ active: $route.name === 'run-subagents' }">Subagents</router-link>
    </nav>
    <main class="content">
      <router-view />
    </main>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { fetchRuns, type RunSummary } from './api'

const route = useRoute()
const router = useRouter()
const selectedRunId = ref(route.params.runId as string || '')
const runs = ref<RunSummary[]>([])
const loading = ref(false)

const loadRuns = async () => {
  loading.value = true
  try {
    runs.value = await fetchRuns()
    // 如果没有选中的runId，自动选择第一个
    if (!selectedRunId.value && runs.value.length > 0) {
      selectedRunId.value = runs.value[0].runId
      updateRoute()
    }
  } catch (error) {
    console.error('Failed to load runs:', error)
  } finally {
    loading.value = false
  }
}

const updateRoute = () => {
  if (selectedRunId.value) {
    router.push(`/runs/${selectedRunId}/memory`)
  }
}

const handleRunChange = () => {
  updateRoute()
}

onMounted(() => {
  loadRuns()
  // 每5秒刷新一次runs列表
  const interval = setInterval(loadRuns, 5000)
  return () => clearInterval(interval)
})
</script>

<style>
:root {
  --bg: #0d1117;
  --surface: #161b22;
  --surface-2: #1c2128;
  --surface-3: #22272e;
  --border: #30363d;
  --text: #e6edf3;
  --text-muted: #7d8590;
  --accent: #58a6ff;
  --accent-dim: #1f3d5c;
  --success: #3fb950;
  --success-dim: #1a3626;
  --danger: #f85149;
  --danger-dim: #3d1a1a;
  --warning: #d29922;
  --warning-dim: #3d2e0a;
  --font-mono: 'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace;
}

* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

body {
  background-color: var(--bg);
  color: var(--text);
}

.app-container {
  height: 100vh;
  display: flex;
  flex-direction: column;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
}

.header {
  padding: 16px 24px;
  background-color: var(--surface);
  color: var(--text);
  display: flex;
  justify-content: space-between;
  align-items: center;
  border-bottom: 1px solid var(--border);
}

.run-selector {
  display: flex;
  align-items: center;
  gap: 8px;
}

.run-selector select {
  padding: 4px 8px;
  border-radius: 4px;
  border: 1px solid var(--border);
  min-width: 300px;
  background-color: var(--surface-2);
  color: var(--text);
}

.loading-indicator {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  0% { transform: rotate(0deg); }
  100% { transform: rotate(360deg); }
}

.tabs {
  display: flex;
  background-color: var(--surface);
  padding: 0 24px;
  gap: 16px;
  border-bottom: 1px solid var(--border);
}

.tab {
  padding: 12px 16px;
  color: var(--text-muted);
  text-decoration: none;
  border-bottom: 3px solid transparent;
  transition: all 0.2s;
}

.tab:hover {
  background-color: var(--surface-3);
  color: var(--text);
}

.tab.active {
  border-bottom-color: var(--accent);
  color: var(--accent);
  background-color: var(--accent-dim);
}

.content {
  flex: 1;
  padding: 20px;
  overflow-y: auto;
  background-color: var(--bg);
}
</style>
