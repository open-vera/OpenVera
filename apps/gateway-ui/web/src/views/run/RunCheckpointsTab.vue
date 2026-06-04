<template>
  <article class="card">
    <p v-if="error" class="muted">{{ error }}</p>
    <table v-else class="table">
      <thead>
        <tr>
          <th>ID</th>
          <th>State</th>
          <th>Flow</th>
          <th>Step</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="checkpoint in checkpoints" :key="checkpoint.checkpointId">
          <td class="mono">{{ checkpoint.checkpointId }}</td>
          <td><span class="status unknown">{{ checkpoint.state }}</span></td>
          <td class="mono">{{ checkpoint.flowId }}</td>
          <td class="mono">{{ checkpoint.activeStepId }}</td>
        </tr>
      </tbody>
    </table>
  </article>
</template>

<script setup lang="ts">
import { inject, onMounted, ref, type Ref } from "vue";
import { gatewayApi, type CheckpointIndex } from "../../api";

defineProps<{ run: unknown; streamEvents: unknown[] }>();

const runId = inject<Ref<string>>("runId")!;
const checkpoints = ref<CheckpointIndex[]>([]);
const error = ref("");

onMounted(async () => {
  try {
    checkpoints.value = await gatewayApi.runs.checkpoints(runId.value);
  } catch (err) {
    error.value = err instanceof Error ? err.message : "无法加载 checkpoints";
  }
});
</script>
