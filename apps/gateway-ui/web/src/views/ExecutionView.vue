<template>
  <section>
    <div class="page-header">
      <div>
        <h2>Execution</h2>
        <p>执行闭环：chat.send 与 flow.run 已接入 Gateway；其余动作待 runtime 扩展。</p>
      </div>
    </div>

    <article class="card toolbar">
      <label class="field">
        <span>项目</span>
        <select v-model="projectId">
          <option v-for="project in projects" :key="project.id" :value="project.id">{{ project.name }}</option>
        </select>
      </label>
    </article>

    <div class="grid cols-2">
      <article v-for="action in actions" :key="action.id" class="card">
        <h3>{{ action.title }}</h3>
        <p class="muted">{{ action.description }}</p>
        <button class="button" :disabled="!projectId" @click="run(action.id)">Run</button>
      </article>
    </div>

    <article v-if="result" class="card result-card">
      <h3>Last Result</h3>
      <p>{{ result.message }}</p>
      <p class="mono muted">trace: {{ result.traceId }}</p>
      <pre v-if="result.data" class="json-block">{{ JSON.stringify(result.data, null, 2) }}</pre>
      <router-link v-if="runLink" class="link" :to="runLink">查看 Run</router-link>
    </article>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { gatewayApi, type ActionResult, type GatewayProject } from "../api";

const result = ref<ActionResult>();
const projects = ref<GatewayProject[]>([]);
const projectId = ref("");

const actions = [
  { id: "chat.send", title: "Chat", description: "写入会话存储并返回占位 assistant 回复。" },
  { id: "flow.run", title: "Flow Run", description: "在项目根目录启动 openvera flow run。" },
  { id: "rag.search", title: "RAG Search", description: "执行知识库检索（待接入）。" },
  { id: "mcp.tool.call", title: "MCP Tool Call", description: "调用 MCP tool（待接入）。" },
  { id: "sandbox.run", title: "Sandbox Run", description: "执行 sandbox run（待接入）。" },
];

const runLink = computed(() => {
  const runId = result.value?.data?.runId;
  return typeof runId === "string" ? `/runs/${runId}` : "";
});

onMounted(async () => {
  projects.value = await gatewayApi.projects.list();
  if (projects.value[0]) projectId.value = projects.value[0].id;
});

async function run(action: string): Promise<void> {
  const payload =
    action === "chat.send"
      ? { message: "Gateway execution smoke test" }
      : action === "flow.run"
        ? { flowDir: projects.value.find((p) => p.id === projectId.value)?.rootDir }
        : { dryRun: true };
  result.value = await gatewayApi.execute(action, { projectId: projectId.value, payload });
}
</script>

<style scoped>
.toolbar {
  margin-bottom: 16px;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 13px;
}

.field select {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 8px;
  background: var(--bg);
  color: var(--text);
}

.button {
  margin-top: 12px;
  border: 1px solid var(--accent);
  border-radius: 8px;
  padding: 8px 12px;
  color: var(--accent);
  background: var(--accent-dim);
  cursor: pointer;
}

.button:disabled {
  opacity: 0.5;
}

.result-card {
  margin-top: 16px;
}

.json-block {
  max-height: 200px;
  overflow: auto;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px;
  background: var(--bg);
}

.link {
  display: inline-block;
  margin-top: 8px;
  color: var(--accent);
}
</style>
