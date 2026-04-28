<template>
  <div class="flow-runner">
    <div class="form">
      <div class="field">
        <label>Flow 模板</label>
        <select v-model="selectedDir">
          <option value="">当前目录 (.)</option>
          <option v-for="t in templates" :key="t.dir" :value="t.dir">
            {{ t.name }}
          </option>
        </select>
      </div>

      <div v-if="selectedTemplate" class="steps-preview">
        <span v-for="s in selectedTemplate.steps" :key="s" class="step-tag">{{ s }}</span>
      </div>

      <div class="field">
        <label>模型 <span class="hint">（留空用默认）</span></label>
        <input v-model="model" placeholder="claude-opus-4-6" />
      </div>

      <div class="field checkbox">
        <label>
          <input v-model="skipPlanCritique" type="checkbox" />
          跳过 plan critique（调试用）
        </label>
      </div>

      <button
        class="run-btn"
        :disabled="running"
        @click="spawnRun"
      >
        {{ running ? "启动中…" : "▶ 启动 Flow" }}
      </button>

      <div v-if="error" class="run-error">{{ error }}</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import { api } from "../api";
import type { FlowTemplate } from "../types";

const emit = defineEmits<{ spawned: [runId: string] }>();

const templates = ref<FlowTemplate[]>([]);
const selectedDir = ref("");
const model = ref("");
const skipPlanCritique = ref(false);
const running = ref(false);
const error = ref<string>();

const selectedTemplate = computed(() =>
  templates.value.find((t) => t.dir === selectedDir.value)
);

onMounted(async () => {
  try {
    templates.value = await api.flows.list();
  } catch {
    // non-fatal
  }
});

async function spawnRun() {
  running.value = true;
  error.value = undefined;
  try {
    const result = await api.runs.spawn({
      flowDir: selectedDir.value || undefined,
      model: model.value || undefined,
      skipPlanCritique: skipPlanCritique.value || undefined,
    });
    emit("spawned", result.runId);
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    running.value = false;
  }
}
</script>

<style scoped>
.flow-runner { padding: 16px; }

.form { display: flex; flex-direction: column; gap: 12px; }

.field { display: flex; flex-direction: column; gap: 4px; }
.field label { font-size: 12px; color: var(--text-muted); font-weight: 500; }
.field.checkbox label { flex-direction: row; align-items: center; gap: 6px; font-size: 13px; color: var(--text); cursor: pointer; }
.hint { font-weight: 400; }

select, input[type="text"], input:not([type]) {
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: 4px;
  color: var(--text);
  font-size: 13px;
  padding: 6px 8px;
  outline: none;
  font-family: inherit;
}
select:focus, input:focus { border-color: var(--accent); }

.steps-preview {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.step-tag {
  font-size: 11px;
  padding: 2px 8px;
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: 10px;
  color: var(--text-muted);
}

.run-btn {
  padding: 8px 16px;
  background: var(--accent);
  color: #fff;
  border: none;
  border-radius: 6px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  align-self: flex-start;
}
.run-btn:hover { opacity: 0.85; }
.run-btn:disabled { opacity: 0.5; cursor: not-allowed; }

.run-error { font-size: 12px; color: var(--danger); }
</style>
