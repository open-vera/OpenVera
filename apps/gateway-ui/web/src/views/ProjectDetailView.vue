<template>
  <section>
    <div class="page-header">
      <div>
        <h2>{{ project?.name ?? projectId }}</h2>
        <p v-if="project" class="mono muted">{{ project.rootDir }}</p>
      </div>
      <router-link class="back-link" to="/projects">返回项目列表</router-link>
    </div>

    <p v-if="error" class="error">{{ error }}</p>
    <p v-else-if="loading" class="muted">Loading project...</p>

    <template v-else-if="project">
      <div class="grid cols-4">
        <article class="card">
          <h3>状态</h3>
          <span class="status" :class="project.activity?.status ?? 'idle'">{{ project.activity?.status ?? "idle" }}</span>
        </article>
        <article class="card">
          <h3>Runs</h3>
          <div class="metric">{{ project.activity?.runCount ?? 0 }}</div>
        </article>
        <article class="card">
          <h3>Capabilities</h3>
          <div class="metric">{{ project.capabilities.length }}</div>
        </article>
        <article class="card">
          <h3>Active run</h3>
          <router-link
            v-if="project.activity?.activeRunId"
            class="mono"
            :to="`/runs/${project.activity.activeRunId}`"
          >
            {{ project.activity.activeRunId }}
          </router-link>
          <span v-else class="muted">—</span>
        </article>
      </div>

      <div class="grid cols-3 links">
        <router-link class="card link-card" :to="`/runs?project=${project.id}`">Runs</router-link>
        <router-link class="card link-card" to="/chat">Chat</router-link>
        <router-link class="card link-card" to="/rag">RAG</router-link>
      </div>

      <article class="card">
        <h3>Capabilities</h3>
        <table class="table">
          <tbody>
            <tr v-for="capability in project.capabilities" :key="capability.id">
              <td><span class="status" :class="capability.status">{{ capability.kind }}</span></td>
              <td>{{ capability.name }}</td>
              <td class="mono muted">{{ capability.source }}</td>
            </tr>
          </tbody>
        </table>
      </article>
    </template>
  </section>
</template>

<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useRoute } from "vue-router";
import { gatewayApi, type ProjectDetail } from "../api";

const route = useRoute();
const projectId = String(route.params.projectId);
const project = ref<ProjectDetail>();
const loading = ref(true);
const error = ref("");

onMounted(async () => {
  try {
    project.value = await gatewayApi.projects.get(projectId);
  } catch (err) {
    error.value = err instanceof Error ? err.message : "Failed to load project";
  } finally {
    loading.value = false;
  }
});
</script>

<style scoped>
.back-link {
  color: var(--accent);
  text-decoration: none;
}

.links {
  margin: 16px 0;
}

.link-card {
  color: var(--text);
  text-decoration: none;
}
</style>
