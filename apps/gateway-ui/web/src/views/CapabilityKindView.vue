<template>
  <section>
    <div class="page-header">
      <div>
        <h2>{{ title }}</h2>
        <p>{{ description }}</p>
      </div>
      <router-link v-if="manageAction" class="action-link" to="/management">管理动作</router-link>
    </div>

    <p v-if="error" class="error">{{ error }}</p>
    <p v-else-if="loading" class="muted">Loading capabilities...</p>

    <table v-else class="table">
      <thead>
        <tr>
          <th>名称</th>
          <th>状态</th>
          <th>路径</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="capability in capabilities" :key="capability.id">
          <td>
            <strong>{{ capability.name }}</strong>
            <div class="mono muted">{{ capability.projectId ?? "global" }}</div>
          </td>
          <td><span class="status" :class="capability.status">{{ capability.status }}</span></td>
          <td class="mono">{{ capability.configPath ?? capability.source }}</td>
          <td>{{ capability.actions.join(", ") }}</td>
        </tr>
      </tbody>
    </table>

    <article v-if="!loading && capabilities.length === 0 && !error" class="card">
      <p class="muted">当前未发现 {{ kind }} 能力描述符。</p>
    </article>
  </section>
</template>

<script setup lang="ts">
import { onMounted, ref } from "vue";
import { gatewayApi, type CapabilityDescriptor, type CapabilityKind } from "../api";

const props = defineProps<{
  kind: CapabilityKind;
  title: string;
  description: string;
  manageAction?: string;
}>();

const capabilities = ref<CapabilityDescriptor[]>([]);
const loading = ref(true);
const error = ref("");

onMounted(async () => {
  try {
    capabilities.value = await gatewayApi.capabilities(props.kind);
  } catch (err) {
    error.value = err instanceof Error ? err.message : "Failed to load capabilities";
  } finally {
    loading.value = false;
  }
});
</script>

<style scoped>
.action-link {
  color: var(--accent);
  text-decoration: none;
}
</style>
