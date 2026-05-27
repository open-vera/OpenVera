<template>
  <div class="space-detail-container">
    <!-- 面包屑导航 -->
    <div class="breadcrumb">
      <router-link to="/spaces">📦 Spaces</router-link>
      <span class="separator">/</span>
      <span class="current">{{ scopeId }}</span>
    </div>

    <!-- 加载状态 -->
    <div v-if="loading" class="loading-state">
      <div class="spinner"></div>
      <p>加载空间信息中...</p>
    </div>

    <!-- 错误状态 -->
    <div v-else-if="error" class="error-state">
      <p class="error-text">❌ 加载失败: {{ error }}</p>
      <button @click="loadSpaceDetail" class="retry-btn">重试</button>
    </div>

    <!-- 空状态 -->
    <div v-else-if="!space" class="empty-state">
      <p>未找到该空间信息</p>
    </div>

    <!-- 空间详情内容 -->
    <div v-else class="detail-content">
      <!-- 基本信息卡片 -->
      <div class="info-card">
        <h2>空间基本信息</h2>
        <div class="info-grid">
          <div class="info-item">
            <label>Scope ID:</label>
            <span class="value">{{ space.scope_id }}</span>
          </div>
          <div class="info-item">
            <label>类型:</label>
            <span class="badge" :class="space.type">
              {{ space.type === 'group' ? '👥 群组空间' : '👤 用户空间' }}
            </span>
          </div>
          <div class="info-item">
            <label>状态:</label>
            <span class="status-badge" :class="space.busy ? 'busy' : 'idle'">
              {{ space.busy ? '🔴 忙碌' : '🟢 空闲' }}
            </span>
          </div>
          <div class="info-item" v-if="space.running_task">
            <label>运行任务:</label>
            <div class="task-info">
              <div class="task-id">{{ space.running_task.task_id }}</div>
              <div class="task-prompt">{{ space.running_task.prompt }}</div>
              <div class="task-time">启动时间: {{ formatTime(space.running_task.started_at) }}</div>
            </div>
          </div>
          <div class="info-item" v-else>
            <label>运行任务:</label>
            <span class="no-task">无运行任务</span>
          </div>
        </div>
      </div>

      <!-- 统计信息卡片 -->
      <div class="info-card" v-if="space.stats">
        <h2>空间统计</h2>
        <div class="stats-grid">
          <div class="stat-item">
            <div class="stat-number">{{ space.stats.memory_entries }}</div>
            <div class="stat-label">记忆条目</div>
          </div>
          <div class="stat-item">
            <div class="stat-number">{{ space.stats.checkpoints }}</div>
            <div class="stat-label">检查点</div>
          </div>
          <div class="stat-item">
            <div class="stat-number">{{ space.stats.subagents }}</div>
            <div class="stat-label">子代理</div>
          </div>
        </div>
      </div>

      <!-- 定时任务列表 -->
      <div class="info-card">
        <h2>定时任务</h2>
        <div v-if="scheduledTasks.length === 0" class="no-tasks">
          <p>暂无定时任务</p>
        </div>
        <div v-else class="tasks-list">
          <div v-for="task in scheduledTasks" :key="task.task_id" class="task-item">
            <div class="task-header">
              <span class="task-name">{{ task.prompt }}</span>
              <span class="task-status" :class="task.enabled ? 'active' : 'disabled'">
                {{ task.enabled ? '✅ 启用' : '❌ 禁用' }}
              </span>
            </div>
            <div class="task-schedule">
              计划: {{ task.schedule }}
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useRoute } from 'vue-router';
import { fetchSpaceDetail, AdminSpaceDetail } from '../api';

const route = useRoute();
const scopeId = route.params.scopeId as string;

const space = ref<AdminSpaceDetail | null>(null);
const loading = ref(false);
const error = ref<string | null>(null);
const scheduledTasks = ref<Array<{
  task_id: string;
  prompt: string;
  schedule: string;
  enabled: boolean;
}>>([]);

// 格式化时间
const formatTime = (timestamp: string) => {
  try {
    const date = new Date(timestamp);
    return date.toLocaleString('zh-CN');
  } catch (e) {
    return timestamp;
  }
};

const loadSpaceDetail = async () => {
  loading.value = true;
  error.value = null;
  try {
    const data = await fetchSpaceDetail(scopeId);
    space.value = data;

    // 模拟加载定时任务数据（实际项目中需要调用对应的API）
    if (data.running_task) {
      scheduledTasks.value = [
        {
          task_id: data.running_task.task_id,
          prompt: data.running_task.prompt,
          schedule: '每30分钟',
          enabled: true
        }
      ];
    } else {
      scheduledTasks.value = [];
    }
  } catch (err) {
    error.value = err instanceof Error ? err.message : '未知错误';
    console.error('Failed to load space detail:', err);
  } finally {
    loading.value = false;
  }
};

onMounted(() => {
  loadSpaceDetail();
});
</script>

<style scoped>
.space-detail-container {
  padding: 20px;
}

.breadcrumb {
  margin-bottom: 20px;
  font-size: 14px;
  color: var(--text-muted);
}

.breadcrumb a {
  color: var(--accent);
  text-decoration: none;
}

.breadcrumb a:hover {
  text-decoration: underline;
}

.separator {
  margin: 0 8px;
}

.current {
  color: var(--text);
  font-family: monospace;
}

.loading-state, .error-state, .empty-state {
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

.retry-btn {
  padding: 8px 16px;
  background-color: var(--accent);
  color: white;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  margin-top: 10px;
}

.retry-btn:hover {
  background-color: var(--accent);
  opacity: 0.9;
}

.detail-content {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.info-card {
  background-color: var(--surface);
  padding: 20px;
  border-radius: 8px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
}

.info-card h2 {
  margin: 0 0 20px 0;
  font-size: 18px;
  color: var(--text);
}

.info-grid {
  display: grid;
  gap: 16px;
}

.info-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.info-item label {
  font-size: 13px;
  color: var(--text-muted);
}

.info-item .value {
  font-size: 14px;
  color: var(--text);
  font-family: monospace;
}

.badge {
  display: inline-block;
  padding: 4px 8px;
  border-radius: 4px;
  font-size: 12px;
  font-weight: 500;
  max-width: fit-content;
}

.badge.group {
  background-color: var(--accent-dim);
  color: var(--accent);
}

.badge.user {
  background-color: var(--success-dim);
  color: var(--success);
}

.status-badge {
  display: inline-block;
  padding: 4px 8px;
  border-radius: 4px;
  font-size: 12px;
  font-weight: 500;
  max-width: fit-content;
}

.status-badge.busy {
  background-color: var(--danger-dim);
  color: var(--danger);
}

.status-badge.idle {
  background-color: var(--success-dim);
  color: var(--success);
}

.task-info {
  margin-top: 8px;
  padding: 10px;
  background-color: var(--surface-2);
  border-radius: 4px;
}

.task-id {
  font-family: monospace;
  font-size: 13px;
  color: var(--accent);
  margin-bottom: 4px;
}

.task-prompt {
  font-size: 13px;
  color: var(--text);
  margin-bottom: 4px;
}

.task-time {
  font-size: 12px;
  color: var(--text-muted);
}

.no-task {
  color: var(--text-muted);
  font-size: 13px;
}

.stats-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 16px;
}

.stat-item {
  text-align: center;
  padding: 16px;
  background-color: var(--surface-2);
  border-radius: 8px;
}

.stat-number {
  font-size: 28px;
  font-weight: bold;
  color: var(--accent);
  margin-bottom: 4px;
}

.stat-label {
  font-size: 13px;
  color: var(--text-muted);
}

.tasks-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.task-item {
  padding: 12px;
  background-color: var(--surface-2);
  border-radius: 4px;
  border-left: 4px solid var(--accent);
}

.task-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 4px;
}

.task-name {
  font-size: 14px;
  color: var(--text);
  font-weight: 500;
}

.task-status {
  font-size: 12px;
  padding: 2px 6px;
  border-radius: 4px;
}

.task-status.active {
  background-color: var(--success-dim);
  color: var(--success);
}

.task-status.disabled {
  background-color: var(--surface-3);
  color: var(--text-muted);
}

.task-schedule {
  font-size: 12px;
  color: var(--text-muted);
}

.no-tasks {
  text-align: center;
  padding: 20px;
  color: var(--text-muted);
}
</style>
