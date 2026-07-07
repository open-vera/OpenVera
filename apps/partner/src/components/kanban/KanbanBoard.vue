<script setup lang="ts">
import { storeToRefs } from "pinia";
import { useKanbanStore } from "@/stores/kanban";

const kanban = useKanbanStore();
const { tasks } = storeToRefs(kanban);
</script>

<template>
  <section class="kanban">
    <header>
      <h2>任务看板</h2>
      <span class="count">{{ tasks.length }} 项</span>
    </header>
    <p v-if="!tasks.length" class="empty">多实例任务编排将在 Phase 4 启用</p>
    <ul v-else>
      <li v-for="task in tasks" :key="task.id">{{ task.title }}</li>
    </ul>
  </section>
</template>

<style scoped>
.kanban {
  padding: 12px 16px;
  border-top: 1px solid var(--border);
  background: var(--surface);
}

header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
}

header h2 {
  margin: 0;
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-muted);
}

.count {
  font-size: 11px;
  color: var(--text-muted);
}

.empty {
  margin: 0;
  font-size: 12px;
  color: var(--text-muted);
}

ul {
  margin: 0;
  padding: 0;
  list-style: none;
}

li {
  padding: 6px 0;
  font-size: 13px;
  border-bottom: 1px solid var(--border);
}
</style>
