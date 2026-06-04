<template>
  <section>
    <div class="page-header">
      <div>
        <h2>RAG</h2>
        <p>检索项目 `.vera/rag` 文档（关键词模式；向量库存在时将提示接入 embedding）。</p>
      </div>
      <router-link class="action-link" to="/capabilities">全部能力</router-link>
    </div>

    <article class="card toolbar">
      <label class="field">
        <span>项目</span>
        <select v-model="projectId">
          <option v-for="project in projects" :key="project.id" :value="project.id">{{ project.name }}</option>
        </select>
      </label>
      <form class="search-row" @submit.prevent="search">
        <input v-model="query" placeholder="搜索关键词..." />
        <button type="submit" :disabled="searching">搜索</button>
      </form>
    </article>

    <p v-if="error" class="error">{{ error }}</p>
    <p v-else-if="result?.message" class="muted">{{ result.message }}</p>

    <table v-if="result?.hits.length" class="table">
      <tbody>
        <tr v-for="hit in result.hits" :key="hit.path">
          <td class="mono">{{ hit.path }}</td>
          <td>{{ hit.snippet }}</td>
        </tr>
      </tbody>
    </table>
  </section>
</template>

<script setup lang="ts">
import { onMounted, ref } from "vue";
import { gatewayApi, type GatewayProject, type RagSearchResult } from "../api";

const projects = ref<GatewayProject[]>([]);
const projectId = ref("");
const query = ref("");
const result = ref<RagSearchResult>();
const searching = ref(false);
const error = ref("");

async function search(): Promise<void> {
  if (!projectId.value || !query.value.trim()) return;
  searching.value = true;
  error.value = "";
  try {
    result.value = await gatewayApi.rag.search(projectId.value, query.value);
  } catch (err) {
    error.value = err instanceof Error ? err.message : "Search failed";
  } finally {
    searching.value = false;
  }
}

onMounted(async () => {
  projects.value = await gatewayApi.projects.list();
  if (projects.value[0]) projectId.value = projects.value[0].id;
});
</script>

<style scoped>
.action-link {
  color: var(--accent);
  text-decoration: none;
}

.toolbar {
  margin-bottom: 16px;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 12px;
}

.field select,
.search-row input {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 8px;
  background: var(--bg);
  color: var(--text);
}

.search-row {
  display: flex;
  gap: 8px;
}

.search-row button {
  border: 1px solid var(--accent);
  border-radius: 8px;
  padding: 8px 12px;
  color: var(--accent);
  background: var(--accent-dim);
  cursor: pointer;
}
</style>
