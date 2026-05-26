<template>
  <div class="app-container">
    <header class="header">
      <h1>Vera Core UI</h1>
      <div class="run-selector">
        <label>Run ID:</label>
        <select v-model="selectedRunId">
          <option value="">Select a run</option>
        </select>
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
import { ref } from 'vue'
import { useRoute } from 'vue-router'

const route = useRoute()
const selectedRunId = ref(route.params.runId as string || '')
</script>

<style>
* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

.app-container {
  height: 100vh;
  display: flex;
  flex-direction: column;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
}

.header {
  padding: 16px 24px;
  background-color: #2c3e50;
  color: white;
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.run-selector {
  display: flex;
  align-items: center;
  gap: 8px;
}

.run-selector select {
  padding: 4px 8px;
  border-radius: 4px;
  border: none;
}

.tabs {
  display: flex;
  background-color: #34495e;
  padding: 0 24px;
  gap: 16px;
}

.tab {
  padding: 12px 16px;
  color: white;
  text-decoration: none;
  border-bottom: 3px solid transparent;
  transition: all 0.2s;
}

.tab:hover {
  background-color: #4a5f7a;
}

.tab.active {
  border-bottom-color: #3498db;
  background-color: #3498db;
}

.content {
  flex: 1;
  padding: 20px;
  overflow-y: auto;
}
</style>
