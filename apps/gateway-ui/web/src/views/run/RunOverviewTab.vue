<template>
  <div v-if="run" class="grid cols-4">
    <article class="card">
      <h3>Status</h3>
      <span class="status" :class="run.status">{{ run.status }}</span>
    </article>
    <article class="card">
      <h3>Steps</h3>
      <div class="metric">{{ run.completedSteps }}/{{ run.totalSteps }}</div>
    </article>
    <article class="card">
      <h3>Artifacts</h3>
      <div class="metric">{{ run.artifactIds.length }}</div>
    </article>
    <article class="card">
      <h3>Goal</h3>
      <p class="muted">{{ run.goal || "未记录" }}</p>
    </article>
  </div>

  <div v-if="run" class="grid cols-2 detail-grid">
    <article class="card">
      <h3>Steps</h3>
      <table class="table compact">
        <tbody>
          <tr v-for="step in run.steps" :key="step.stepId">
            <td class="mono">{{ step.stepId }}</td>
            <td><span class="status" :class="step.status">{{ step.status }}</span></td>
            <td>{{ step.agents.join(", ") || "—" }}</td>
          </tr>
        </tbody>
      </table>
    </article>

    <article class="card">
      <h3>Artifacts</h3>
      <button v-for="artifactId in run.artifactIds" :key="artifactId" class="pill" @click="loadArtifact(artifactId)">
        {{ artifactId }}
      </button>
      <pre v-if="artifactPreview" class="json-block">{{ artifactPreview }}</pre>
    </article>
  </div>
</template>

<script setup lang="ts">
import { inject, ref, type Ref } from "vue";
import { gatewayApi, type RunDetail } from "../../api";

defineProps<{
  run: RunDetail;
  streamEvents: unknown[];
}>();

const runId = inject<Ref<string>>("runId")!;
const artifactPreview = ref("");

async function loadArtifact(artifactId: string): Promise<void> {
  const data = await gatewayApi.runs.artifact(runId.value, artifactId);
  artifactPreview.value = JSON.stringify(data, null, 2);
}
</script>

<style scoped>
.detail-grid {
  margin-top: 16px;
}

.compact td {
  padding: 6px;
}

.pill {
  margin: 0 8px 8px 0;
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 6px 10px;
  color: var(--text);
  background: var(--surface-2);
  cursor: pointer;
}

.json-block {
  max-height: 280px;
  overflow: auto;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px;
  background: var(--bg);
}
</style>
