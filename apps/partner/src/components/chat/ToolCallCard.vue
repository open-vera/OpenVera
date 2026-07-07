<script setup lang="ts">
import type { ToolCall } from "@/types";
import { ref } from "vue";

defineProps<{
  toolCall: ToolCall;
  status?: "pending" | "done" | "error";
}>();

const expanded = ref(false);
</script>

<template>
  <div class="tool-card">
    <button type="button" class="header" @click="expanded = !expanded">
      <span>🔧 {{ toolCall.name }}</span>
      <span class="status">{{ status ?? "pending" }}</span>
    </button>
    <pre v-if="expanded" class="body">{{
      JSON.stringify(toolCall.input, null, 2)
    }}</pre>
  </div>
</template>

<style scoped>
.tool-card {
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
  font-size: 12px;
}

.header {
  display: flex;
  justify-content: space-between;
  width: 100%;
  padding: 8px 12px;
  border: none;
  background: var(--surface);
  cursor: pointer;
  font: inherit;
  color: inherit;
}

.status {
  color: var(--text-muted);
}

.body {
  margin: 0;
  padding: 8px 12px;
  background: var(--surface-elevated);
  overflow: auto;
}
</style>
