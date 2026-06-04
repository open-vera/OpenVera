<template>
  <section class="runs-workspace">
    <div class="page-header">
      <div>
        <h2>Runs</h2>
        <p>查看 Flow 模板、启动运行，并在侧栏选择 Run 查看详情与实时事件。</p>
      </div>
    </div>

    <p v-if="error" class="error">{{ error }}</p>

    <div class="workspace-layout">
      <aside class="sidebar-panel">
        <article class="card">
          <h3>启动 Flow</h3>
          <label class="field">
            <span>项目</span>
            <select v-model="spawn.projectId">
              <option v-for="project in projects" :key="project.id" :value="project.id">{{ project.name }}</option>
            </select>
          </label>
          <label class="field">
            <span>Flow</span>
            <select v-model="spawn.flowDir">
              <option v-for="flow in projectFlows" :key="`${flow.projectId}-${flow.name}`" :value="flow.dir">
                {{ flow.name }} ({{ flow.projectName }})
              </option>
            </select>
          </label>
          <button class="button" :disabled="spawning || !spawn.flowDir" @click="startRun">Start run</button>
          <p v-if="spawnMessage" class="muted">{{ spawnMessage }}</p>
        </article>

        <article class="card">
          <h3>运行列表</h3>
          <p v-if="loading" class="muted">Loading...</p>
          <router-link
            v-for="run in runs"
            :key="run.runId"
            class="run-item"
            :class="{ active: selectedRunId === run.runId }"
            :to="`/runs/${run.runId}`"
          >
            <span>
              <span class="mono">{{ run.runId }}</span>
              <span class="muted small">{{ run.projectName }}</span>
            </span>
            <span class="status" :class="run.status">{{ run.status }}</span>
          </router-link>
          <p v-if="!loading && runs.length === 0" class="muted">暂无运行记录</p>
        </article>
      </aside>

      <div class="detail-panel">
        <router-view v-if="selectedRunId" />
        <article v-else class="card empty-state">
          <h3>选择一次运行</h3>
          <p class="muted">从左侧列表打开 Run，查看步骤、Memory、Checkpoint 与 Timeline。</p>
        </article>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { gatewayApi, type FlowTemplate, type GatewayProject, type RunSummary } from "../api";

const route = useRoute();
const router = useRouter();
const runs = ref<RunSummary[]>([]);
const flows = ref<FlowTemplate[]>([]);
const projects = ref<GatewayProject[]>([]);
const loading = ref(true);
const error = ref("");
const spawning = ref(false);
const spawnMessage = ref("");
const spawn = ref({ projectId: "", flowDir: "" });
let interval: number | undefined;

const selectedRunId = computed(() => (route.params.runId ? String(route.params.runId) : ""));
const projectFlows = computed(() =>
  flows.value.filter((flow) => !spawn.value.projectId || flow.projectId === spawn.value.projectId),
);

async function loadData(): Promise<void> {
  const projectList = await gatewayApi.projects.list();
  projects.value = projectList;
  if (!spawn.value.projectId && projectList[0]) spawn.value.projectId = projectList[0].id;
  const [runList, flowList] = await Promise.all([
    gatewayApi.runs.list(spawn.value.projectId || undefined),
    gatewayApi.flows(spawn.value.projectId || undefined),
  ]);
  runs.value = runList;
  flows.value = flowList;
  if (!spawn.value.flowDir && projectFlows.value[0]) spawn.value.flowDir = projectFlows.value[0].dir;
}

watch(
  () => spawn.value.projectId,
  () => {
    void loadData().catch(() => undefined);
  },
);

async function startRun(): Promise<void> {
  spawning.value = true;
  spawnMessage.value = "";
  try {
    const result = await gatewayApi.runs.spawn({
      projectId: spawn.value.projectId || undefined,
      flowDir: spawn.value.flowDir || undefined,
    });
    spawnMessage.value = `已启动 ${result.runId}`;
    await loadData();
    await router.push(`/runs/${result.runId}`);
  } catch (err) {
    spawnMessage.value = err instanceof Error ? err.message : "启动失败";
  } finally {
    spawning.value = false;
  }
}

watch(
  () => route.params.runId,
  () => {
    if (runs.value.some((run) => run.status === "running")) void loadData().catch(() => undefined);
  },
);

onMounted(async () => {
  try {
    await loadData();
  } catch (err) {
    error.value = err instanceof Error ? err.message : "Failed to load runs workspace";
  } finally {
    loading.value = false;
  }
  interval = window.setInterval(() => {
    if (runs.value.some((run) => run.status === "running")) {
      void loadData().catch(() => undefined);
    }
  }, 5000);
});

onUnmounted(() => {
  if (interval !== undefined) window.clearInterval(interval);
});
</script>

<style scoped>
.workspace-layout {
  display: grid;
  grid-template-columns: 320px 1fr;
  gap: 16px;
  margin-top: 16px;
}

.sidebar-panel {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 10px;
  font-size: 13px;
}

.field select {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 8px;
  color: var(--text);
  background: var(--bg);
}

.button {
  border: 1px solid var(--accent);
  border-radius: 8px;
  padding: 8px 12px;
  color: var(--accent);
  background: var(--accent-dim);
  cursor: pointer;
}

.button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.run-item {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  align-items: center;
  border-bottom: 1px solid var(--border);
  padding: 10px 0;
  color: var(--text);
  text-decoration: none;
}

.run-item.active {
  color: var(--accent);
}

.small {
  display: block;
  font-size: 11px;
}

.empty-state {
  min-height: 320px;
}
</style>
