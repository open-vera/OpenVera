<template>
  <section v-if="loading" class="muted">Loading run...</section>
  <section v-else-if="error" class="error">{{ error }}</section>
  <section v-else-if="run" class="run-shell">
    <div class="page-header compact">
      <div>
        <h2 class="mono">{{ runId }}</h2>
        <p>{{ run.projectName }} · {{ run.status }} · ${{ run.costUsd.toFixed(6) }}</p>
      </div>
      <button v-if="!streaming" class="button" @click="connect">连接事件流</button>
      <button v-else class="button" @click="disconnect">断开</button>
    </div>

    <nav class="tabs">
      <router-link v-for="tab in tabs" :key="tab.name" class="tab" :to="tab.to">{{ tab.label }}</router-link>
    </nav>

    <router-view v-if="run" :run="run" :stream-events="streamEvents" />
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, provide, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { gatewayApi, type RunDetail } from "../../api";
import { useRunStream } from "../../composables/useStream";

const route = useRoute();
const runId = computed(() => String(route.params.runId));
const run = ref<RunDetail>();
const loading = ref(true);
const error = ref("");
const { events: streamEvents, streaming, connect, disconnect } = useRunStream(() => runId.value);

const tabs = computed(() => [
  { name: "overview", label: "概览", to: `/runs/${runId.value}` },
  { name: "memory", label: "Memory", to: `/runs/${runId.value}/memory` },
  { name: "checkpoints", label: "Checkpoints", to: `/runs/${runId.value}/checkpoints` },
  { name: "subagents", label: "Subagents", to: `/runs/${runId.value}/subagents` },
  { name: "timeline", label: "Timeline", to: `/runs/${runId.value}/timeline` },
]);

provide("runId", runId);

async function loadRun(): Promise<void> {
  loading.value = true;
  error.value = "";
  try {
    run.value = await gatewayApi.runs.get(runId.value);
  } catch (err) {
    error.value = err instanceof Error ? err.message : "Failed to load run";
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  void loadRun().then(() => {
    if (run.value?.status === "running") connect();
  });
});

watch(runId, () => {
  disconnect();
  void loadRun();
});
</script>

<style scoped>
.compact h2 {
  margin: 0;
  font-size: 18px;
}

.tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 12px 0 16px;
}

.tab {
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 6px 12px;
  color: var(--text-muted);
  text-decoration: none;
}

.tab.router-link-active {
  border-color: var(--accent);
  color: var(--accent);
  background: var(--accent-dim);
}

.button {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 8px 12px;
  color: var(--text);
  background: var(--surface-2);
  cursor: pointer;
}
</style>
