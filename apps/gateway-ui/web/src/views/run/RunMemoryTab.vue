<template>
  <article class="card">
    <div class="toolbar">
      <input v-model="search" placeholder="搜索 memory..." @keyup.enter="reload" />
      <select v-model="tier" @change="reload">
        <option value="">全部 tier</option>
        <option value="episodic">episodic</option>
        <option value="semantic">semantic</option>
        <option value="working">working</option>
      </select>
      <button class="button" @click="reload">刷新</button>
    </div>

    <p v-if="error" class="muted">{{ error }}</p>
    <template v-else-if="memory">
      <p class="muted">
        episodic {{ memory.snapshot.episodicCount }} · semantic {{ memory.snapshot.semanticCount }} · working
        {{ memory.snapshot.workingCount }}
      </p>
      <div v-for="entry in memory.entries" :key="entry.id" class="list-item">
        <span class="status unknown">{{ entry.tier }}</span>
        <span>{{ entry.content || entry.source }}</span>
      </div>
    </template>
  </article>
</template>

<script setup lang="ts">
import { inject, onMounted, ref, type Ref } from "vue";
import { gatewayApi, type MemoryResponse } from "../../api";

defineProps<{ run: unknown; streamEvents: unknown[] }>();

const runId = inject<Ref<string>>("runId")!;
const memory = ref<MemoryResponse>();
const error = ref("");
const search = ref("");
const tier = ref("");

async function reload(): Promise<void> {
  error.value = "";
  try {
    memory.value = await gatewayApi.runs.memory(runId.value, tier.value || undefined, search.value || undefined);
  } catch (err) {
    error.value = err instanceof Error ? err.message : "无法加载 memory";
  }
}

onMounted(() => {
  void reload();
});
</script>

<style scoped>
.toolbar {
  display: flex;
  gap: 8px;
  margin-bottom: 12px;
}

.toolbar input,
.toolbar select {
  flex: 1;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 8px;
  color: var(--text);
  background: var(--bg);
}

.button {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 8px 12px;
  background: var(--surface-2);
  cursor: pointer;
}

.list-item {
  display: flex;
  gap: 8px;
  border-bottom: 1px solid var(--border);
  padding: 8px 0;
}
</style>
