<template>
  <section>
    <div class="page-header">
      <div>
        <h2>Cost</h2>
        <p>费用管理作为 Gateway 一等能力，按 run 汇总 token/cost 轨迹。</p>
      </div>
    </div>

    <p v-if="error" class="error">{{ error }}</p>
    <p v-else-if="loading" class="muted">Loading cost summary...</p>

    <template v-else-if="cost">
      <div class="grid cols-2">
        <article class="card">
          <h3>Total Cost</h3>
          <div class="metric">{{ cost.currency }} {{ cost.totalUsd.toFixed(6) }}</div>
        </article>
        <article class="card">
          <h3>Runs</h3>
          <div class="metric">{{ cost.runCount }}</div>
        </article>
      </div>

      <table class="table cost-table">
        <thead>
          <tr>
            <th>Run</th>
            <th>Status</th>
            <th>Started</th>
            <th>Cost</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="run in cost.byRun" :key="run.runId">
            <td class="mono">{{ run.runId }}</td>
            <td><span class="status" :class="run.status">{{ run.status }}</span></td>
            <td>{{ new Date(run.startedAt).toLocaleString() }}</td>
            <td>{{ cost.currency }} {{ run.costUsd.toFixed(6) }}</td>
          </tr>
        </tbody>
      </table>
    </template>
  </section>
</template>

<script setup lang="ts">
import { onMounted, ref } from "vue";
import { gatewayApi, type CostSummary } from "../api";

const cost = ref<CostSummary>();
const loading = ref(true);
const error = ref("");

onMounted(async () => {
  try {
    cost.value = await gatewayApi.cost();
  } catch (err) {
    error.value = err instanceof Error ? err.message : "Failed to load cost";
  } finally {
    loading.value = false;
  }
});
</script>

<style scoped>
.cost-table {
  margin-top: 16px;
}
</style>
