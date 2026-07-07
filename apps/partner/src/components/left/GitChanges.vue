<script setup lang="ts">
import type { GitChange } from "@/types";

defineProps<{
  changes: GitChange[];
}>();
</script>

<template>
  <section class="git-changes">
    <ul v-if="changes.length">
      <li v-for="change in changes" :key="change.path">
        <span class="status">{{ change.status }}</span>
        <span class="path">{{ change.path }}</span>
      </li>
    </ul>
    <p v-else class="empty">暂无变更</p>
  </section>
</template>

<style scoped>
.git-changes {
  margin-top: 8px;
}

ul {
  list-style: none;
  margin: 0;
  padding: 0;
}

li {
  display: flex;
  gap: 8px;
  padding: 4px 0;
  font-size: 12px;
}

.status {
  color: var(--accent);
  font-family: monospace;
  min-width: 24px;
}

.path {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.empty {
  margin: 0;
  font-size: 12px;
  color: var(--text-muted);
}
</style>
