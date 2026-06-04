<template>
  <section>
    <div class="page-header">
      <div>
        <h2>Capabilities</h2>
        <p>聚合管理 config、RAG、memory、skills、MCP、channels、sandbox、flows、logs 等能力。</p>
      </div>
    </div>

    <div class="toolbar">
      <input v-model="search" class="input" placeholder="Search capability..." />
      <select v-model="kind" class="input">
        <option value="">All kinds</option>
        <option v-for="item in kinds" :key="item" :value="item">{{ item }}</option>
      </select>
    </div>

    <p v-if="error" class="error">{{ error }}</p>
    <p v-else-if="loading" class="muted">Loading capabilities...</p>

    <table v-else class="table">
      <thead>
        <tr>
          <th>Capability</th>
          <th>Kind</th>
          <th>Status</th>
          <th>Actions</th>
          <th>Source</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="capability in filteredCapabilities" :key="capability.id">
          <td>
            <strong>{{ capability.name }}</strong>
            <div class="mono muted">{{ capability.id }}</div>
          </td>
          <td><span class="status unknown">{{ capability.kind }}</span></td>
          <td><span class="status" :class="capability.status">{{ capability.status }}</span></td>
          <td>{{ capability.actions.join(", ") }}</td>
          <td>
            <div class="mono">{{ capability.configPath ?? capability.source }}</div>
            <div v-if="capability.health?.message" class="muted">{{ capability.health.message }}</div>
          </td>
        </tr>
      </tbody>
    </table>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { gatewayApi, type CapabilityDescriptor } from "../api";

const capabilities = ref<CapabilityDescriptor[]>([]);
const loading = ref(true);
const error = ref("");
const search = ref("");
const kind = ref("");

const kinds = computed(() => [...new Set(capabilities.value.map((capability) => capability.kind))].sort());
const filteredCapabilities = computed(() => {
  const query = search.value.trim().toLowerCase();
  return capabilities.value.filter((capability) => {
    const matchesKind = !kind.value || capability.kind === kind.value;
    const matchesSearch =
      !query ||
      capability.name.toLowerCase().includes(query) ||
      capability.id.toLowerCase().includes(query) ||
      capability.source.toLowerCase().includes(query);
    return matchesKind && matchesSearch;
  });
});

onMounted(async () => {
  try {
    capabilities.value = await gatewayApi.capabilities();
  } catch (err) {
    error.value = err instanceof Error ? err.message : "Failed to load capabilities";
  } finally {
    loading.value = false;
  }
});
</script>
