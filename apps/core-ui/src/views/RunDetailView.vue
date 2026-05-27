<template>
  <div class="run-detail-container">
    <div v-if="loading" class="loading-state">
      <div class="spinner"></div>
      <p>加载运行详情中...</p>
    </div>

    <div v-else-if="!run" class="empty-state">
      <p>未找到该运行详情</p>
    </div>

    <div v-else class="detail-content">
      <!-- 基本信息卡片 -->
      <div class="info-card">
        <h2>运行基本信息</h2>
        <div class="info-grid">
          <div class="info-item">
            <label>运行ID:</label>
            <span class="value">{{ run.runId }}</span>
          </div>
          <div class="info-item">
            <label>状态:</label>
            <span class="status-badge" :class="run.status">
              {{ statusMap[run.status] }}
            </span>
          </div>
          <div class="info-item">
            <label>开始时间:</label>
            <span class="value">{{ formatTime(run.startedAt) }}</span>
          </div>
          <div class="info-item">
            <label>结束时间:</label>
            <span class="value">{{ run.endedAt ? formatTime(run.endedAt) : '-' }}</span>
          </div>
          <div class="info-item">
            <label>耗时:</label>
            <span class="value">{{ formatDuration(run.durationMs) }}</span>
          </div>
          <div class="info-item">
            <label>目标:</label>
            <span class="value goal-text">{{ run.goal || '-' }}</span>
          </div>
        </div>
      </div>

      <!-- 步骤统计卡片 -->
      <div class="info-card">
        <h2>步骤统计</h2>
        <div class="stats-grid">
          <div class="stat-item">
            <div class="stat-number">{{ run.totalSteps }}</div>
            <div class="stat-label">总步骤数</div>
          </div>
          <div class="stat-item">
            <div class="stat-number completed">{{ run.completedSteps }}</div>
            <div class="stat-label">已完成</div>
          </div>
          <div class="stat-item">
            <div class="stat-number failed">{{ run.failedSteps }}</div>
            <div class="stat-label">失败</div>
          </div>
          <div class="stat-item">
            <div class="stat-number progress">{{ run.totalSteps - run.completedSteps - run.failedSteps }}</div>
            <div class="stat-label">进行中</div>
          </div>
        </div>

        <!-- 进度条 -->
        <div class="overall-progress">
          <div class="progress-label">
            <span>整体进度</span>
            <span>{{ progressPercent }}%</span>
          </div>
          <div class="progress-bar">
            <div
              class="progress-fill"
              :style="{
                width: `${progressPercent}%`,
                backgroundColor: getProgressColor()
              }"
            ></div>
          </div>
        </div>
      </div>

      <!-- 步骤列表 -->
      <div class="steps-card">
        <h2>步骤列表</h2>
        <div class="steps-list">
          <div
            v-for="step in run.steps"
            :key="step.stepId"
            class="step-item"
          >
            <div class="step-header">
              <div class="step-info">
                <span class="step-id">{{ step.stepId }}</span>
                <span class="step-status" :class="step.status">
                  {{ statusMap[step.status] }}
                </span>
              </div>
              <div class="step-meta">
                <span v-if="step.startedAt" class="step-time">{{ formatDuration(Date.now() - new Date(step.startedAt).getTime()) }}</span>
              </div>
            </div>
            <div v-if="step.score !== undefined" class="step-score">
              得分: {{ step.score }}
            </div>
            <div v-if="step.retries > 0" class="step-retries">
              重试次数: {{ step.retries }}
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, computed } from 'vue';
import { useRoute } from 'vue-router';
import { fetchRun, type RunDetail } from '../api';

const route = useRoute();
const runId = route.params.runId as string;

const run = ref<RunDetail | null>(null);
const loading = ref(false);

const statusMap = {
  pending: '⏳ 待执行',
  running: '🟢 运行中',
  done: '✅ 已完成',
  completed: '✅ 已完成',
  failed: '❌ 失败',
  paused: '⏸️ 已暂停'
};

const progressPercent = computed(() => {
  if (!run.value) return 0;
  return Math.round((run.value.completedSteps / run.value.totalSteps) * 100);
});

const getProgressColor = () => {
  if (!run.value) return '#95a5a6';
  if (run.value.status === 'failed') return '#e74c3c';
  if (run.value.status === 'completed') return '#2ecc71';
  return '#3498db';
};

const loadRunDetail = async () => {
  loading.value = true;
  try {
    run.value = await fetchRun(runId);
  } catch (error) {
    console.error('Failed to load run detail:', error);
  } finally {
    loading.value = false;
  }
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
  loadRunDetail();
  // 每5秒刷新一次
  const interval = setInterval(loadRunDetail, 5000);
  return () => clearInterval(interval);
});
</script>

<style scoped>
.run-detail-container {
  padding: 20px;
}

.loading-state, .empty-state {
  text-align: center;
  padding: 40px;
  color: var(--text-secondary, #b0b0b0);
}

.spinner {
  width: 40px;
  height: 40px;
  border: 4px solid var(--border-color, #404040);
  border-top: 4px solid var(--accent-primary, #3498db);
  border-radius: 50%;
  animation: spin 1s linear infinite;
  margin: 0 auto 20px;
}

@keyframes spin {
  0% { transform: rotate(0deg); }
  100% { transform: rotate(360deg); }
}

.detail-content {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.info-card {
  background-color: var(--card-bg, #2d2d2d);
  padding: 20px;
  border-radius: 8px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
}

.info-card h2 {
  margin: 0 0 20px 0;
  font-size: 18px;
  color: var(--text-primary, #ffffff);
}

.info-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
  gap: 16px;
}

.info-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.info-item label {
  font-size: 13px;
  color: var(--text-secondary, #b0b0b0);
}

.info-item .value {
  font-size: 14px;
  color: var(--text-primary, #ffffff);
  font-family: monospace;
}

.goal-text {
  font-family: inherit;
  white-space: pre-wrap;
  word-break: break-word;
}

.status-badge {
  display: inline-block;
  padding: 4px 8px;
  border-radius: 4px;
  font-size: 12px;
  font-weight: 500;
  max-width: fit-content;
}

.status-badge.running {
  background-color: rgba(46, 204, 113, 0.2);
  color: #2ecc71;
}

.status-badge.completed {
  background-color: rgba(46, 204, 113, 0.2);
  color: #2ecc71;
}

.status-badge.failed {
  background-color: rgba(231, 76, 60, 0.2);
  color: #e74c3c;
}

.status-badge.paused {
  background-color: rgba(153, 153, 153, 0.2);
  color: #999;
}

.stats-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 16px;
  margin-bottom: 20px;
}

.stat-item {
  text-align: center;
  padding: 16px;
  background-color: var(--bg-secondary, #404040);
  border-radius: 8px;
}

.stat-number {
  font-size: 28px;
  font-weight: bold;
  margin-bottom: 4px;
}

.stat-number.completed {
  color: #2ecc71;
}

.stat-number.failed {
  color: #e74c3c;
}

.stat-number.progress {
  color: #3498db;
}

.stat-label {
  font-size: 13px;
  color: var(--text-secondary, #b0b0b0);
}

.overall-progress {
  margin-top: 10px;
}

.progress-label {
  display: flex;
  justify-content: space-between;
  margin-bottom: 8px;
  font-size: 14px;
  color: var(--text-secondary, #b0b0b0);
}

.progress-bar {
  height: 12px;
  background-color: var(--bg-secondary, #404040);
  border-radius: 6px;
  overflow: hidden;
}

.progress-fill {
  height: 100%;
  border-radius: 6px;
  transition: width 0.3s ease;
}

.steps-card {
  background-color: var(--card-bg, #2d2d2d);
  padding: 20px;
  border-radius: 8px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
}

.steps-card h2 {
  margin: 0 0 20px 0;
  font-size: 18px;
  color: var(--text-primary, #ffffff);
}

.steps-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.step-item {
  padding: 12px;
  background-color: var(--bg-secondary, #404040);
  border-radius: 4px;
  border-left: 4px solid var(--accent-primary, #3498db);
}

.step-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
}

.step-info {
  display: flex;
  align-items: center;
  gap: 10px;
}

.step-id {
  font-size: 14px;
  font-weight: 500;
  color: var(--text-primary, #ffffff);
}

.step-status {
  padding: 2px 6px;
  border-radius: 4px;
  font-size: 12px;
}

.step-status.running {
  background-color: rgba(46, 204, 113, 0.2);
  color: #2ecc71;
}

.step-status.done {
  background-color: rgba(46, 204, 113, 0.2);
  color: #2ecc71;
}

.step-status.failed {
  background-color: rgba(231, 76, 60, 0.2);
  color: #e74c3c;
}

.step-status.pending {
  background-color: rgba(153, 153, 153, 0.2);
  color: #999;
}

.step-meta {
  font-size: 12px;
  color: var(--text-secondary, #b0b0b0);
}

.step-score, .step-retries {
  font-size: 12px;
  color: var(--text-secondary, #b0b0b0);
  margin-top: 4px;
}
</style>