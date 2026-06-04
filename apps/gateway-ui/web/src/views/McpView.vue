<template>
  <section>
    <div class="page-header">
      <div>
        <h2>MCP</h2>
        <p>发现本地 MCP server 配置；工具调用通过 Execution 或后续 Core 客户端执行。</p>
      </div>
    </div>

    <article class="card toolbar">
      <label class="field">
        <span>项目</span>
        <select v-model="projectId" @change="reload">
          <option v-for="project in projects" :key="project.id" :value="project.id">{{ project.name }}</option>
        </select>
      </label>
    </article>

    <p v-if="error" class="error">{{ error }}</p>
    <p v-else-if="loading" class="muted">Loading MCP servers...</p>

    <div v-else class="grid cols-2">
      <article class="card">
        <h3>Servers</h3>
        <table class="table">
          <tbody>
            <tr v-for="server in servers" :key="server.id">
              <td><strong>{{ server.name }}</strong><div class="mono muted">{{ server.id }}</div></td>
              <td>{{ server.transport ?? "stdio" }}</td>
              <td class="mono muted">{{ server.source }}</td>
            </tr>
          </tbody>
        </table>
        <p v-if="servers.length === 0" class="muted">未发现 MCP 配置</p>
      </article>

      <article class="card">
        <h3>Tools (摘要)</h3>
        <div v-for="tool in tools" :key="`${tool.serverId}-${tool.name}`" class="list-item">
          <span class="mono">{{ tool.name }}</span>
          <span class="muted">{{ tool.description }}</span>
        </div>
        <p v-if="tools.length === 0" class="muted">无工具摘要</p>
      </article>
    </div>
  </section>
</template>

<script setup lang="ts">
import { onMounted, ref } from "vue";
import { gatewayApi, type GatewayProject, type McpServerSummary, type McpToolSummary } from "../api";

const projects = ref<GatewayProject[]>([]);
const projectId = ref("");
const servers = ref<McpServerSummary[]>([]);
const tools = ref<McpToolSummary[]>([]);
const loading = ref(true);
const error = ref("");

async function reload(): Promise<void> {
  if (!projectId.value) return;
  loading.value = true;
  error.value = "";
  try {
    const [serverList, toolList] = await Promise.all([
      gatewayApi.mcp.servers(projectId.value),
      gatewayApi.mcp.tools(projectId.value),
    ]);
    servers.value = serverList;
    tools.value = toolList;
  } catch (err) {
    error.value = err instanceof Error ? err.message : "Failed to load MCP";
  } finally {
    loading.value = false;
  }
}

onMounted(async () => {
  projects.value = await gatewayApi.projects.list();
  if (projects.value[0]) {
    projectId.value = projects.value[0].id;
    await reload();
  } else {
    loading.value = false;
  }
});
</script>

<style scoped>
.toolbar {
  margin-bottom: 16px;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.field select {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 8px;
  background: var(--bg);
  color: var(--text);
}

.list-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
  border-bottom: 1px solid var(--border);
  padding: 8px 0;
}
</style>
