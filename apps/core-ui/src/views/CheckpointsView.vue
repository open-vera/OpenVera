<template>
  <div class="checkpoints-container">
    <div class="page-header">
      <h1>检查点管理</h1>
      <button @click="refreshCheckpoints" class="refresh-btn" :disabled="loading">
        {{ loading ? '🔄 刷新中...' : '🔄 刷新' }}
      </button>
    </div>

    <div v-if="loading && checkpoints.length === 0" class="loading-state">
      <div class="spinner"></div>
      <p>加载检查点数据中...</p>
    </div>

    <div v-else-if="checkpoints.length === 0" class="empty-state">
      <p>暂无检查点数据</p>
    </div>

    <div v-else class="checkpoints-timeline">
      <div
        v-for="(checkpoint, index) in checkpoints"
        :key="checkpoint.checkpointId"
        class="timeline-item"
        :class="{ active: selectedCheckpointId === checkpoint.checkpointId }"
      >
        <div class="timeline-node">
          <div class="node-dot" :class="getCheckpointClass(checkpoint.state)"></div>
          <div class="timeline-line" v-if="index < checkpoints.length - 1"></div>
        </div>
        <div class="timeline-content" @click="selectCheckpoint(checkpoint)">
          <div class="checkpoint-header">
            <div class="checkpoint-info">
              <span class="checkpoint-id">{{ checkpoint.checkpointId }}</span>
              <span class="checkpoint-state-badge" :class="checkpoint.state">
                {{ stateLabels[checkpoint.state] || checkpoint.state }}
              </span>
            </div>
            <span class="checkpoint-time">{{ formatTime(checkpoint.createdAt) }}</span>
          </div>
          <div class="checkpoint-meta">
            <span class="step-id">步骤: {{ checkpoint.activeStepId }}</span>
            <span class="flow-id">Flow: {{ checkpoint.flowId }}</span>
          </div>
        </div>
      </div>
    </div>

    <!-- 检查点详情弹窗 -->
    <div v-if="selectedCheckpoint" class="checkpoint-modal-overlay" @click.self="closeModal">
      <div class="checkpoint-modal">
        <div class="modal-header">
          <h2>检查点详情</h2>
          <button @click="closeModal" class="close-btn">×</button>
        </div>
        <div class="modal-content">
          <div class="detail-section">
            <label>检查点ID:</label>
            <span class="value">{{ selectedCheckpoint.checkpointId }}</span>
          </div>
          <div class="detail-section">
            <label>Flow ID:</label>
            <span class="value">{{ selectedCheckpoint.flowId }}</span>
          </div>
          <div class="detail-section">
            <label>状态:</label>
            <span class="value badge" :class="selectedCheckpoint.state">
              {{ stateLabels[selectedCheckpoint.state] || selectedCheckpoint.state }}
            </span>
          </div>
          <div class="detail-section">
            <label>创建时间:</label>
            <span class="value">{{ formatTime(selectedCheckpoint.createdAt) }}</span>
          </div>
          <div class="detail-section">
            <label>当前步骤:</label>
            <span class="value">{{ selectedCheckpoint.activeStepId }}</span>
          </div>
          <div class="detail-section full-width">
            <label>原始JSON:</label>
            <pre class="json-viewer">{{ JSON.stringify(selectedCheckpoint, null, 2) }}</pre>
          </div>
        </div>
        <div class="modal-actions">
          <button @click="copyCheckpointId" class="copy-btn">复制ID</button>
          <button @click="closeModal" class="close-btn">关闭</button>
        </div>
      </div>
    </div>

    <!-- Diff模式按钮 -->
    <div v-if="checkpoints.length > 1" class="diff-buttons">
      <button
        @click="enterDiffMode"
        class="diff-btn"
        :disabled="!!(selectedCheckpointA && selectedCheckpointB)"
      >
        选择 A
      </button>
      <button
        @click="enterDiffMode"
        class="diff-btn"
        :disabled="!!(selectedCheckpointA && selectedCheckpointB)"
      >
        选择 B
      </button>
      <button
        v-if="selectedCheckpointA && selectedCheckpointB"
        @click="clearDiffSelection"
        class="clear-diff-btn"
      >
        清除选择
      </button>
    </div>

    <!-- Diff 对比组件 -->
    <div v-if="selectedCheckpointA && selectedCheckpointB" class="diff-container">
      <CheckpointDiff
        :checkpoint-a="selectedCheckpointA"
        :checkpoint-b="selectedCheckpointB"
        @swap="swapDiffCheckpoints"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useRoute } from 'vue-router';
import { fetchCheckpoints, type Checkpoint } from '../api';
import CheckpointDiff from '../components/CheckpointDiff.vue';

const route = useRoute();
const runId = route.params.runId as string;

const checkpoints = ref<Checkpoint[]>([]);
const loading = ref(false);
const selectedCheckpointId = ref<string | null>(null);
const selectedCheckpoint = ref<Checkpoint | null>(null);
const selectedCheckpointA = ref<Checkpoint | null>(null);
const selectedCheckpointB = ref<Checkpoint | null>(null);

const stateLabels: Record<string, string> = {
  running: '🟢 运行中',
  completed: '✅ 已完成',
  failed: '❌ 失败',
  paused: '⏸️ 已暂停',
  pending: '⏳ 待执行'
};

const getCheckpointClass = (state: string): string => {
  return state;
};

const loadCheckpoints = async () => {
  loading.value = true;
  try {
    checkpoints.value = await fetchCheckpoints(runId);
    // 按创建时间排序，最新的在前
    checkpoints.value.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  } catch (error) {
    console.error('Failed to load checkpoints:', error);
  } finally {
    loading.value = false;
  }
};

const refreshCheckpoints = () => {
  loadCheckpoints();
};

const selectCheckpoint = (checkpoint: Checkpoint) => {
  selectedCheckpoint.value = checkpoint;
  selectedCheckpointId.value = checkpoint.checkpointId;
};

const enterDiffMode = () => {
  if (!selectedCheckpoint.value) return;

  if (!selectedCheckpointA.value) {
    selectedCheckpointA.value = selectedCheckpoint.value;
  } else if (!selectedCheckpointB.value && selectedCheckpointA.value.checkpointId !== selectedCheckpoint.value.checkpointId) {
    selectedCheckpointB.value = selectedCheckpoint.value;
  }
};

const clearDiffSelection = () => {
  selectedCheckpointA.value = null;
  selectedCheckpointB.value = null;
};

const swapDiffCheckpoints = () => {
  [selectedCheckpointA.value, selectedCheckpointB.value] = [selectedCheckpointB.value, selectedCheckpointA.value];
};

const closeModal = () => {
  selectedCheckpoint.value = null;
  selectedCheckpointId.value = null;
};

const copyCheckpointId = () => {
  if (selectedCheckpoint.value) {
    navigator.clipboard.writeText(selectedCheckpoint.value.checkpointId);
    alert('已复制检查点ID: ' + selectedCheckpoint.value.checkpointId);
  }
};

const formatTime = (timestamp: string) => {
  try {
    return new Date(timestamp).toLocaleString('zh-CN');
  } catch (e) {
    return timestamp;
  }
};

onMounted(() => {
  loadCheckpoints();
  // 每15秒刷新一次
  const interval = setInterval(loadCheckpoints, 15000);
  return () => clearInterval(interval);
});
</script>

<style scoped>
.checkpoints-container {
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
  color: var(--text-primary, #ffffff);
  margin: 0;
}

.refresh-btn {
  padding: 8px 16px;
  background-color: var(--accent-primary, #3498db);
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

.checkpoints-timeline {
  position: relative;
  max-width: 800px;
  margin: 0 auto;
}

.timeline-item {
  display: flex;
  margin-bottom: 24px;
  position: relative;
  cursor: pointer;
  transition: all 0.2s;
}

.timeline-item:hover .timeline-content {
  background-color: var(--bg-secondary, #404040);
}

.timeline-item.active .timeline-content {
  background-color: var(--accent-primary, rgba(52, 152, 219, 0.1));
  border-color: var(--accent-primary, #3498db);
}

.timeline-node {
  position: relative;
  margin-right: 20px;
  display: flex;
  flex-direction: column;
  align-items: center;
}

.node-dot {
  width: 16px;
  height: 16px;
  border-radius: 50%;
  border: 3px solid var(--card-bg, #2d2d2d);
  z-index: 2;
}

.node-dot.running {
  background-color: #2ecc71;
}

.node-dot.completed {
  background-color: #2ecc71;
}

.node-dot.failed {
  background-color: #e74c3c;
}

.node-dot.paused {
  background-color: #f39c12;
}

.node-dot.pending {
  background-color: #95a5a6;
}

.timeline-line {
  position: absolute;
  top: 16px;
  left: 50%;
  width: 2px;
  height: calc(100% + 8px);
  background-color: var(--border-color, #404040);
  transform: translateX(-50%);
  z-index: 1;
}

.timeline-content {
  flex: 1;
  padding: 16px;
  background-color: var(--card-bg, #2d2d2d);
  border-radius: 8px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
  border: 1px solid var(--border-color, #404040);
}

.checkpoint-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
}

.checkpoint-info {
  display: flex;
  align-items: center;
  gap: 8px;
}

.checkpoint-id {
  font-size: 14px;
  font-weight: 500;
  color: var(--text-primary, #ffffff);
  font-family: monospace;
}

.checkpoint-state-badge {
  padding: 2px 6px;
  border-radius: 4px;
  font-size: 12px;
  font-weight: 500;
}

.checkpoint-state-badge.running {
  background-color: rgba(46, 204, 113, 0.2);
  color: #2ecc71;
}

.checkpoint-state-badge.completed {
  background-color: rgba(46, 204, 113, 0.2);
  color: #2ecc71;
}

.checkpoint-state-badge.failed {
  background-color: rgba(231, 76, 60, 0.2);
  color: #e74c3c;
}

.checkpoint-state-badge.paused {
  background-color: rgba(243, 156, 18, 0.2);
  color: #f39c12;
}

.checkpoint-state-badge.pending {
  background-color: rgba(149, 165, 166, 0.2);
  color: #95a5a6;
}

.checkpoint-time {
  font-size: 12px;
  color: var(--text-secondary, #b0b0b0);
}

.checkpoint-meta {
  display: flex;
  gap: 16px;
  font-size: 12px;
  color: var(--text-secondary, #b0b0b0);
}

.checkpoint-modal-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background-color: rgba(0, 0, 0, 0.7);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.checkpoint-modal {
  background-color: var(--card-bg, #2d2d2d);
  border-radius: 8px;
  padding: 24px;
  max-width: 800px;
  width: 90%;
  max-height: 90vh;
  overflow-y: auto;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5);
}

.modal-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 20px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--border-color, #404040);
}

.modal-header h2 {
  margin: 0;
  font-size: 20px;
  color: var(--text-primary, #ffffff);
}

.close-btn {
  padding: 8px 12px;
  background-color: var(--bg-secondary, #404040);
  color: var(--text-primary, #ffffff);
  border: none;
  border-radius: 4px;
  cursor: pointer;
  font-size: 16px;
}

.close-btn:hover {
  background-color: var(--accent-hover, #34495e);
}

.modal-content {
  margin-bottom: 20px;
}

.detail-section {
  margin-bottom: 16px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.detail-section.full-width {
  width: 100%;
}

.detail-section label {
  font-size: 13px;
  color: var(--text-secondary, #b0b0b0);
}

.detail-section .value {
  font-size: 14px;
  color: var(--text-primary, #ffffff);
  font-family: monospace;
}

.detail-section .value.badge {
  display: inline-block;
  padding: 4px 8px;
  border-radius: 4px;
  width: fit-content;
}

.json-viewer {
  padding: 12px;
  background-color: var(--bg-secondary, #404040);
  border-radius: 4px;
  overflow-x: auto;
  font-size: 13px;
  color: var(--text-primary, #ffffff);
  white-space: pre-wrap;
  word-wrap: break-word;
  max-height: 300px;
}

.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--border-color, #404040);
}

.copy-btn {
  padding: 8px 16px;
  background-color: var(--accent-primary, #3498db);
  color: white;
  border: none;
  border-radius: 4px;
  cursor: pointer;
}

.copy-btn:hover {
  background-color: #2980b9;
}

.diff-buttons {
  display: flex;
  gap: 12px;
  margin-bottom: 20px;
  justify-content: center;
}

.diff-btn {
  padding: 10px 24px;
  background-color: var(--bg-secondary, #404040);
  color: var(--text-primary, #ffffff);
  border: 1px solid var(--border-color, #404040);
  border-radius: 4px;
  cursor: pointer;
  font-size: 14px;
  transition: all 0.2s;
}

.diff-btn:hover:not(:disabled) {
  background-color: var(--accent-primary, rgba(52, 152, 219, 0.1));
  border-color: var(--accent-primary, #3498db);
}

.diff-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.diff-btn:nth-child(1).active {
  background-color: rgba(46, 204, 113, 0.2);
  border-color: #2ecc71;
  color: #2ecc71;
}

.diff-btn:nth-child(2).active {
  background-color: rgba(52, 152, 219, 0.2);
  border-color: #3498db;
  color: #3498db;
}

.clear-diff-btn {
  padding: 10px 24px;
  background-color: var(--bg-danger, rgba(231, 76, 60, 0.1));
  color: var(--text-danger, #e74c3c);
  border: 1px solid var(--border-color, #404040);
  border-radius: 4px;
  cursor: pointer;
  font-size: 14px;
  transition: all 0.2s;
}

.clear-diff-btn:hover {
  background-color: var(--bg-danger, rgba(231, 76, 60, 0.2));
}

.diff-container {
  margin-top: 20px;
}
</style>