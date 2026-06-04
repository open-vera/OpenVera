<template>
  <article class="card">
    <p v-if="error" class="muted">{{ error }}</p>
    <template v-else-if="subagents">
      <p class="muted">
        active {{ subagents.poolStatus.activeAgents }} / {{ subagents.poolStatus.totalSlots }}, queued
        {{ subagents.poolStatus.queuedTasks }}
      </p>
      <pre class="json-block">{{ JSON.stringify(subagents.callTree, null, 2) }}</pre>
    </template>
  </article>
</template>

<script setup lang="ts">
import { inject, onMounted, ref, type Ref } from "vue";
import { gatewayApi, type SubagentResponse } from "../../api";

defineProps<{ run: unknown; streamEvents: unknown[] }>();

const runId = inject<Ref<string>>("runId")!;
const subagents = ref<SubagentResponse>();
const error = ref("");

onMounted(async () => {
  try {
    subagents.value = await gatewayApi.runs.subagents(runId.value);
  } catch (err) {
    error.value = err instanceof Error ? err.message : "无法加载 subagents";
  }
});
</script>

<style scoped>
.json-block {
  max-height: 480px;
  overflow: auto;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px;
  background: var(--bg);
}
</style>
