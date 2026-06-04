<template>
  <section>
    <div class="page-header">
      <div>
        <h2>Projects</h2>
        <p>从 Gateway 统一发现本地项目和 `.vera` 资源路径。</p>
      </div>
    </div>

    <p v-if="error" class="error">{{ error }}</p>
    <p v-else-if="loading" class="muted">Loading projects...</p>

    <table v-else class="table">
      <thead>
        <tr>
          <th>Name</th>
          <th>Source</th>
          <th>Root</th>
          <th>Flows</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="project in projects" :key="project.id">
          <td>
            <router-link :to="`/projects/${project.id}`">
              <strong>{{ project.name }}</strong>
            </router-link>
            <div class="mono muted">{{ project.id }}</div>
          </td>
          <td><span class="status available">{{ project.source }}</span></td>
          <td class="mono">{{ project.rootDir }}</td>
          <td class="mono">{{ project.flowsDir }}</td>
        </tr>
      </tbody>
    </table>
  </section>
</template>

<script setup lang="ts">
import { onMounted, ref } from "vue";
import { gatewayApi, type GatewayProject } from "../api";

const projects = ref<GatewayProject[]>([]);
const loading = ref(true);
const error = ref("");

onMounted(async () => {
  try {
    projects.value = await gatewayApi.projects.list();
  } catch (err) {
    error.value = err instanceof Error ? err.message : "Failed to load projects";
  } finally {
    loading.value = false;
  }
});
</script>
