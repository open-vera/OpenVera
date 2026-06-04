<template>
  <section>
    <div class="page-header">
      <div>
        <h2>Management</h2>
        <p>可操作管理入口：config 编辑、MCP reload、skill reload、RAG reindex、channel、sandbox。</p>
      </div>
    </div>

    <div class="grid cols-2">
      <article v-for="action in actions" :key="action.id" class="card">
        <h3>{{ action.title }}</h3>
        <p class="muted">{{ action.description }}</p>
        <button class="button" @click="run(action.id)">Run</button>
      </article>
    </div>

    <article v-if="result" class="card result-card">
      <h3>Last Result</h3>
      <p>{{ result.message }}</p>
      <p class="mono muted">trace: {{ result.traceId }}</p>
    </article>
  </section>
</template>

<script setup lang="ts">
import { ref } from "vue";
import { gatewayApi, type ActionResult } from "../api";

const result = ref<ActionResult>();
const actions = [
  { id: "config.edit", title: "Config Edit", description: "编辑 provider/model/routing/session 配置。" },
  { id: "mcp.reload", title: "MCP Reload", description: "重新发现并加载 MCP server/tools/resources。" },
  { id: "skill.reload", title: "Skill Reload", description: "热更新 project/global skills。" },
  { id: "rag.reindex", title: "RAG Reindex", description: "重建文档索引和向量检索数据。" },
  { id: "channel.connect", title: "Channel Connect", description: "连接 CLI/API/Webhook/IM channel。" },
  { id: "channel.disconnect", title: "Channel Disconnect", description: "断开指定 channel adapter。" },
  { id: "sandbox.test", title: "Sandbox Test Call", description: "测试 local/docker/e2b/cubesandbox provider。" },
];

async function run(action: string): Promise<void> {
  result.value = await gatewayApi.manage(action, { dryRun: true });
}
</script>

<style scoped>
.button {
  margin-top: 12px;
  border: 1px solid var(--accent);
  border-radius: 8px;
  padding: 8px 12px;
  color: var(--accent);
  background: var(--accent-dim);
  cursor: pointer;
}

.result-card {
  margin-top: 16px;
}
</style>
