<template>
  <section>
    <div class="page-header">
      <div>
        <h2>Doctor</h2>
        <p>检查项目、flow、配置、RAG、memory、MCP、channel、sandbox 等能力状态。</p>
      </div>
      <span v-if="report" class="status" :class="report.status">{{ report.status }}</span>
    </div>

    <p v-if="error" class="error">{{ error }}</p>
    <p v-else-if="loading" class="muted">Running doctor checks...</p>

    <table v-else-if="report" class="table">
      <thead>
        <tr>
          <th>Status</th>
          <th>Check</th>
          <th>Scope</th>
          <th>Message</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="check in report.checks" :key="check.id">
          <td><span class="status" :class="check.status">{{ check.status }}</span></td>
          <td>
            <strong>{{ check.label }}</strong>
            <div class="mono muted">{{ check.id }}</div>
          </td>
          <td>{{ check.scope }}</td>
          <td>{{ check.message }}</td>
        </tr>
      </tbody>
    </table>
  </section>
</template>

<script setup lang="ts">
import { onMounted, ref } from "vue";
import { gatewayApi, type DoctorReport } from "../api";

const report = ref<DoctorReport>();
const loading = ref(true);
const error = ref("");

onMounted(async () => {
  try {
    report.value = await gatewayApi.doctor();
  } catch (err) {
    error.value = err instanceof Error ? err.message : "Failed to run doctor";
  } finally {
    loading.value = false;
  }
});
</script>
