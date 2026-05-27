<template>
  <div class="runs-container">
    <div class="page-header">
      <h1>Agent 运行列表</h1>
      <button @click="refreshRuns" class="refresh-btn" :disabled="loading">
        {{ loading ? '🔄 刷新中...' : '🔄 刷新' }}
      </button>
    </div>

    <div v-if="loading && runs.length === 0" class="loading-state">
      <div class="spinner"></div>
      <p>加载运行列表中...</p>
    </div>

    <div v-else-if="runs.length === 0" class="empty-state">
      <p>暂无Agent运行记录</p>
    </div>

    <table v-else class="runs-table">
      <thead>
        <tr>
          <th>运行ID</th>
          <th>状态</th>
          <th>开始时间</th>
          <th>耗时</th>
          <th>步骤</th>
          <th>目标</th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="run in runs"
          :key="run.runId"
          @click="goToRunDetail(run.runId)"
          class="run-row"
        >
          <td class="run-id">{{ run.runId }}</td>
          <td>
            <span class="status-badge" :class="run.status">
              {{ statusMap[run.status] }}
            </span>
          </td>
          <td class="timestamp">{{ formatTime(run.startedAt) }}</td>
          <td class="duration">{{ formatDuration(run.durationMs) }}</td>
          <td class="steps">
            <div class="steps-progress">
              <div class="progress-bar">
                <div
                  class="progress-fill"
                  :style="{
                    width: `${(run.completedSteps / run.totalSteps) * 100}%`,
                    backgroundColor: getProgressColor(run.status, run.completedSteps, run.totalSteps)
                  }"
                ></div>
              </div>
              <span class="steps-text">{{ run.completedSteps }}/{{ run.totalSteps }}</span>
            </div>
          </td>
          <td class="goal">{{ run.goal || '-' }}</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { fetchRuns, type RunSummary } from '../api';

const router = useRouter();
const runs = ref<RunSummary[]>([]);
const loading = ref(false);

const statusMap = {
  running: '🟢 运行中',
  completed: '✅ 已完成',
  failed: '❌ 失败',
  paused: '⏸️ 已暂停'
};

const getProgressColor = (status: string, completed: number, total: number) => {
  if (status === 'failed') return 'var(--danger)';
  if (status === 'completed') return 'var(--success)';
  if (completed === 0) return 'var(--text-muted)';
  if (completed === total) return 'var(--success)';
  return 'var(--accent)';
};

const loadRuns = async () => {
  loading.value = true;
  try {
    runs.value = await fetchRuns();
    // 按开始时间排序，最新的在前
    runs.value.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
  } catch (error) {
    console.error('Failed to load runs:', error);
  } finally {
    loading.value = false;
  }
};

const refreshRuns = () => {
  loadRuns();
};

const goToRunDetail = (runId: string) => {
  router.push(`/runs/${runId}/memory`);
};

const formatTime = (timestamp: string) => {
  try {
    return new Date(timestamp).toLocaleString('zh-CN');
  } catch (e) {
    return timestamp;
  }
};

const formatDuration = (durationMs?: number) => {
  if (!durationMs) return '-';
  const seconds = Math.floor(durationMs / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  }
  return `${seconds}s`;
};

onMounted(() => {
  loadRuns();
  // 每5秒自动刷新
  const interval = setInterval(loadRuns, 5000);
  return () => clearInterval(interval);
});
</script>

<style scoped>
.runs-container {
  padding: 20px;
}

.page-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 20px;
}

.page-header h1 {
  font-size: 24px;
  color: var(--text);
  margin: 0;
}

.refresh-btn {
  padding: 8px 16px;
  background-color: var(--accent);
  color: white;
  border: none;
  border-radius: 4px;
  cursor: pointer;
}

.refresh-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.loading-state, .empty-state {
  text-align: center;
  padding: 40px;
  color: var(--text-muted);
}

.spinner {
  width: 40px;
  height: 40px;
  border: 4px solid var(--border);
  border-top: 4px solid var(--accent);
  border-radius: 50%;
  animation: spin 1s linear infinite;
  margin: 0 auto 20px;
}

@keyframes spin {
  0% { transform: rotate(0deg); }
  100% { transform: rotate(360deg); }
}

.runs-table {
  width: 100%;
  border-collapse: collapse;
  background-color: var(--surface);
  border-radius: 8px;
  overflow: hidden;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
}

.runs-table thead {
  background-color: var(--surface-2);
}

.runs-table th {
  padding: 12px 16px;
  text-align: left;
  font-size: 14px;
  font-weight: 600;
  color: var(--text);
}

.runs-table tbody tr {
  border-bottom: 1px solid var(--border);
  cursor: pointer;
  transition: background-color 0.2s;
}

.runs-table tbody tr:hover {
  background-color: var(--surface-2);
}

.runs-table td {
  padding: 12px 16px;
  font-size: 14px;
  color: var(--text);
}

.run-id {
  font-family: monospace;
  font-size: 13px;
}

.status-badge {
  padding: 4px 8px;
  border-radius: 4px;
  font-size: 12px;
  font-weight: 500;
}

.status-badge.running {
  background-color: var(--accent-dim);
  color: var(--accent);
}

.status-badge.completed {
  background-color: var(--success-dim);
  color: var(--success);
}

.status-badge.failed {
  background-color: var(--danger-dim);
  color: var(--danger);
}

.status-badge.paused {
  background-color: var(--warning-dim);
  color: var(--warning);
}

.timestamp {
  color: var(--text-muted);
  font-size: 13px;
}

.duration {
  color: var(--text-muted);
  font-size: 13px;
}

.steps-progress {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.progress-bar {
  height: 8px;
  background-color: var(--surface-2);
  border-radius: 4px;
  overflow: hidden;
}

.progress-fill {
  height: 100%;
  border-radius: 4px;
  transition: width 0.3s ease;
}

.steps-text {
  font-size: 12px;
  color: var(--text-muted);
  text-align: right;
}

.goal {
  max-width: 300px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>