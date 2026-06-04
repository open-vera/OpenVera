<template>
  <section>
    <div class="page-header">
      <div>
        <h2>Overview</h2>
        <p>统一查看项目、能力、运行和健康状态。</p>
      </div>
      <span v-if="overview" class="status" :class="overview.doctorStatus">{{ overview.doctorStatus }}</span>
    </div>

    <p v-if="error" class="error">{{ error }}</p>
    <p v-else-if="loading" class="muted">Loading gateway overview...</p>

    <div v-else-if="overview" class="grid cols-4">
      <article class="card">
        <h3>Projects</h3>
        <div class="metric">{{ overview.projectCount }}</div>
      </article>
      <article class="card">
        <h3>Capabilities</h3>
        <div class="metric">{{ overview.capabilityCount }}</div>
      </article>
      <article class="card">
        <h3>Running</h3>
        <div class="metric">{{ ops?.runningRuns ?? 0 }}</div>
      </article>
      <article class="card">
        <h3>Doctor</h3>
        <div class="metric">{{ overview.doctorStatus }}</div>
      </article>
    </div>

    <div v-if="ops" class="grid cols-3 quick-links">
      <router-link to="/runs" class="card link-card">Runs · {{ ops.runningRuns }} running</router-link>
      <router-link to="/chat" class="card link-card">Chat</router-link>
      <router-link to="/operations" class="card link-card">Operations</router-link>
    </div>

    <div v-if="overview" class="card summary-card">
      <h3>Capability Summary</h3>
      <div class="summary-list">
        <span v-for="[key, value] in summaryEntries" :key="key" class="summary-item">
          <span class="mono">{{ key }}</span>
          <strong>{{ value }}</strong>
        </span>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { gatewayApi, type GatewayOverview, type OperationsSummary } from "../api";

const overview = ref<GatewayOverview>();
const ops = ref<OperationsSummary>();
const loading = ref(true);
const error = ref("");

const summaryEntries = computed(() => Object.entries(overview.value?.capabilitySummary ?? {}));

onMounted(async () => {
  try {
    const [overviewValue, opsValue] = await Promise.all([
      gatewayApi.overview(),
      gatewayApi.operations.summary(),
    ]);
    overview.value = overviewValue;
    ops.value = opsValue;
  } catch (err) {
    error.value = err instanceof Error ? err.message : "Failed to load overview";
  } finally {
    loading.value = false;
  }
});
</script>

<style scoped>
.quick-links {
  margin-top: 16px;
}

.link-card {
  color: var(--text);
  text-decoration: none;
}

.summary-card {
  margin-top: 16px;
}

.summary-list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.summary-item {
  display: inline-flex;
  gap: 8px;
  align-items: center;
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 6px 10px;
  background: var(--surface-2);
}
</style>
