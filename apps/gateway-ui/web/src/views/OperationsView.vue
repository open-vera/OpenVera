<template>
  <section>
    <div class="page-header">
      <div>
        <h2>Operations</h2>
        <p>主机资源、项目活动与 24 小时运行热力图。</p>
      </div>
    </div>

    <p v-if="error" class="error">{{ error }}</p>
    <p v-else-if="loading" class="muted">Loading operations data...</p>

    <template v-else-if="summary">
      <div class="grid cols-4">
        <article class="card">
          <h3>CPU</h3>
          <div class="metric">{{ summary.host.cpu.loadPercent }}%</div>
          <p class="muted">{{ summary.host.cpu.cores }} cores</p>
        </article>
        <article class="card">
          <h3>Memory</h3>
          <div class="metric">{{ summary.host.memory.usedPercent }}%</div>
          <p class="muted">
            {{ formatBytes(summary.host.memory.usedBytes) }} /
            {{ formatBytes(summary.host.memory.totalBytes) }}
          </p>
        </article>
        <article class="card">
          <h3>Disk</h3>
          <div class="metric">{{ summary.host.disk.usedPercent }}%</div>
          <p class="muted">
            {{ formatBytes(summary.host.disk.usedBytes) }} /
            {{ formatBytes(summary.host.disk.totalBytes) }}
          </p>
        </article>
        <article class="card">
          <h3>Running</h3>
          <div class="metric">{{ summary.runningRuns }}</div>
        </article>
      </div>

      <div class="grid cols-2 ops-grid">
        <article class="card">
          <h3>项目活动</h3>
          <table class="table">
            <tbody>
              <tr v-for="project in summary.projects" :key="project.projectId">
                <td>
                  <router-link :to="`/projects/${project.projectId}`">
                    <strong>{{ project.name }}</strong>
                  </router-link>
                  <div class="mono muted">{{ project.rootDir }}</div>
                </td>
                <td><span class="status" :class="project.status">{{ project.status }}</span></td>
                <td>{{ project.runCount }} runs</td>
              </tr>
            </tbody>
          </table>
        </article>

        <article class="card">
          <h3>24h 活动</h3>
          <div class="heatmap">
            <div v-for="bucket in heatmap" :key="bucket.hour" class="bar-wrap">
              <div class="bar" :style="{ height: `${Math.max(4, bucket.runStarts * 12)}px` }"></div>
              <span>{{ bucket.hour }}</span>
            </div>
          </div>
        </article>
      </div>
    </template>
  </section>
</template>

<script setup lang="ts">
import { onMounted, ref } from "vue";
import { gatewayApi, type ActivityBucket, type OperationsSummary } from "../api";

const summary = ref<OperationsSummary>();
const heatmap = ref<ActivityBucket[]>([]);
const loading = ref(true);
const error = ref("");

function formatBytes(value: number): string {
  if (value <= 0) return "—";
  return `${(value / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

onMounted(async () => {
  try {
    const [summaryValue, heatmapValue] = await Promise.all([
      gatewayApi.operations.summary(),
      gatewayApi.operations.activity(),
    ]);
    summary.value = summaryValue;
    heatmap.value = heatmapValue;
  } catch (err) {
    error.value = err instanceof Error ? err.message : "Failed to load operations data";
  } finally {
    loading.value = false;
  }
});
</script>

<style scoped>
.ops-grid {
  margin-top: 16px;
}

.heatmap {
  display: flex;
  align-items: end;
  gap: 6px;
  min-height: 160px;
}

.bar-wrap {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  color: var(--text-muted);
  font-size: 11px;
}

.bar {
  width: 14px;
  border-radius: 4px 4px 0 0;
  background: var(--accent);
}
</style>
