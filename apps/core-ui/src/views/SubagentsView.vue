<template>
  <div class="subagents-container">
    <div class="page-header">
      <h1>子代理管理</h1>
      <button @click="refreshSubagents" class="refresh-btn" :disabled="loading">
        {{ loading ? '🔄 刷新中...' : '🔄 刷新' }}
      </button>
    </div>

    <div v-if="loading && !poolStatus" class="loading-state">
      <div class="spinner"></div>
      <p>加载子代理数据中...</p>
    </div>

    <div v-else class="stats-overview">
      <div class="stat-card">
        <div class="stat-icon">🧩</div>
        <div class="stat-content">
          <div class="stat-number">{{ poolStatus?.totalSlots || 0 }}</div>
          <div class="stat-label">总槽位</div>
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-icon">🟢</div>
        <div class="stat-content">
          <div class="stat-number">{{ poolStatus?.activeAgents || 0 }}</div>
          <div class="stat-label">活跃代理</div>
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-icon">⏳</div>
        <div class="stat-content">
          <div class="stat-number">{{ poolStatus?.queuedTasks || 0 }}</div>
          <div class="stat-label">排队任务</div>
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-icon">📊</div>
        <div class="stat-content">
          <div class="stat-number">{{ utilizationRate }}%</div>
          <div class="stat-label">利用率</div>
        </div>
      </div>
    </div>

    <div v-if="callTree.length === 0" class="empty-state">
      <p>暂无子代理调用数据</p>
    </div>

    <div v-else class="call-tree-container">
      <div class="tree-title">
        <h2>代理调用链</h2>
        <span class="tree-info">共 {{ totalNodes }} 个节点</span>
      </div>
      <div class="tree-root">
        <TreeNode
          v-for="node in callTree"
          :key="node.taskId"
          :node="node"
          :depth="0"
          @expand="toggleExpand"
        />
      </div>
    </div>

    <!-- 节点详情弹窗 -->
    <div v-if="selectedNode" class="node-modal-overlay" @click.self="closeNodeModal">
      <div class="node-modal">
        <div class="modal-header">
          <h2>代理详情</h2>
          <button @click="closeNodeModal" class="close-btn">×</button>
        </div>
        <div class="modal-content">
          <div class="detail-section">
            <label>任务ID:</label>
            <span class="value">{{ selectedNode.taskId }}</span>
          </div>
          <div class="detail-section">
            <label>代理类型:</label>
            <span class="value">{{ selectedNode.agentType }}</span>
          </div>
          <div class="detail-section">
            <label>状态:</label>
            <span class="value badge" :class="selectedNode.status">
              {{ statusMap[selectedNode.status] || selectedNode.status }}
            </span>
          </div>
          <div class="detail-section" v-if="selectedNode.dependsOn">
            <label>依赖任务:</label>
            <div class="value">
              <span v-for="dep in selectedNode.dependsOn" :key="dep" class="dependency-tag">
                {{ dep }}
              </span>
            </div>
          </div>
          <div class="detail-section" v-if="selectedNode.children && selectedNode.children.length > 0">
            <label>子节点数量:</label>
            <span class="value">{{ selectedNode.children.length }}</span>
          </div>
        </div>
        <div class="modal-actions">
          <button @click="copyNodeId" class="copy-btn">复制任务ID</button>
          <button @click="closeNodeModal" class="close-btn">关闭</button>
        </div>
      </div>
    </div>
    <Toast v-model:visible="toastVisible" :message="toastMessage" :type="toastType" />
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed } from 'vue';
import { useRoute } from 'vue-router';
import { fetchSubagents, type SubagentCallTreeNode } from '../api';
import TreeNode from '../components/TreeNode.vue';
import Toast from '../components/Toast.vue';

const route = useRoute();
const runId = route.params.runId as string;

const callTree = ref<SubagentCallTreeNode[]>([]);
const poolStatus = ref<{ totalSlots: number; activeAgents: number; queuedTasks: number } | null>(null);
const loading = ref(false);
const selectedNode = ref<SubagentCallTreeNode | null>(null);
const expandedNodes = ref<Set<string>>(new Set());
const toastVisible = ref(false);
const toastMessage = ref('');
const toastType = ref<'success' | 'danger' | 'info'>('success');

const statusMap = {
  pending: '⏳ 待执行',
  running: '🟢 运行中',
  done: '✅ 已完成',
  failed: '❌ 失败'
};

const utilizationRate = computed(() => {
  if (!poolStatus.value || poolStatus.value.totalSlots === 0) return 0;
  return Math.round((poolStatus.value.activeAgents / poolStatus.value.totalSlots) * 100);
});

const totalNodes = computed(() => {
  const countNodes = (nodes: SubagentCallTreeNode[]): number => {
    let count = 0;
    nodes.forEach(node => {
      count++;
      if (node.children) {
        count += countNodes(node.children);
      }
    });
    return count;
  };
  return countNodes(callTree.value);
});

const loadSubagents = async () => {
  loading.value = true;
  try {
    const data = await fetchSubagents(runId);
    poolStatus.value = data.poolStatus;
    callTree.value = data.callTree || [];
  } catch (error) {
    console.error('Failed to load subagents:', error);
  } finally {
    loading.value = false;
  }
};

const refreshSubagents = () => {
  loadSubagents();
};

const toggleExpand = (nodeId: string) => {
  if (expandedNodes.value.has(nodeId)) {
    expandedNodes.value.delete(nodeId);
  } else {
    expandedNodes.value.add(nodeId);
  }
};

const closeNodeModal = () => {
  selectedNode.value = null;
};

const copyNodeId = () => {
  if (selectedNode.value) {
    navigator.clipboard.writeText(selectedNode.value.taskId);
    toastMessage.value = '已复制任务ID: ' + selectedNode.value.taskId;
    toastType.value = 'success';
    toastVisible.value = true;
  }
};


const refreshTimer = ref<ReturnType<typeof setInterval>>();

onMounted(() => {
  loadSubagents();
  refreshTimer.value = setInterval(loadSubagents, 20000);
});

onUnmounted(() => {
  clearInterval(refreshTimer.value);
});
</script>

<style scoped>
.subagents-container {
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

.stats-overview {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 16px;
  margin-bottom: 20px;
}

.stat-card {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 16px;
  background-color: var(--surface);
  border-radius: 8px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
}

.stat-icon {
  font-size: 32px;
}

.stat-content {
  flex: 1;
}

.stat-number {
  font-size: 28px;
  font-weight: bold;
  color: var(--text);
  margin-bottom: 4px;
}

.stat-label {
  font-size: 13px;
  color: var(--text-muted);
}

.empty-state {
  text-align: center;
  padding: 40px;
  color: var(--text-muted);
  background-color: var(--surface);
  border-radius: 8px;
}

.call-tree-container {
  background-color: var(--surface);
  border-radius: 8px;
  padding: 20px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
}

.tree-title {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 20px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--border);
}

.tree-title h2 {
  margin: 0;
  font-size: 18px;
  color: var(--text);
}

.tree-info {
  font-size: 13px;
  color: var(--text-muted);
}

.tree-root {
  padding-left: 20px;
}

.node-modal-overlay {
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

.node-modal {
  background-color: var(--surface);
  border-radius: 8px;
  padding: 24px;
  max-width: 600px;
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
  border-bottom: 1px solid var(--border);
}

.modal-header h2 {
  margin: 0;
  font-size: 20px;
  color: var(--text);
}

.close-btn {
  padding: 8px 12px;
  background-color: var(--surface-2);
  color: var(--text);
  border: none;
  border-radius: 4px;
  cursor: pointer;
  font-size: 16px;
}

.close-btn:hover {
  background-color: var(--surface-3);
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

.detail-section label {
  font-size: 13px;
  color: var(--text-muted);
}

.detail-section .value {
  font-size: 14px;
  color: var(--text);
  font-family: monospace;
}

.detail-section .value.badge {
  display: inline-block;
  padding: 4px 8px;
  border-radius: 4px;
  width: fit-content;
}

.dependency-tag {
  display: inline-block;
  padding: 2px 6px;
  margin-right: 4px;
  margin-bottom: 4px;
  background-color: var(--surface-2);
  border-radius: 4px;
  font-size: 12px;
  color: var(--accent);
}

.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--border);
}

.copy-btn {
  padding: 8px 16px;
  background-color: var(--accent);
  color: white;
  border: none;
  border-radius: 4px;
  cursor: pointer;
}

.copy-btn:hover {
  background-color: var(--accent-dim);
}

/* 状态徽章样式 */
.badge {
  padding: 4px 8px;
  border-radius: 4px;
  font-size: 12px;
  font-weight: 500;
}

.badge.running {
  background-color: var(--success-dim);
  color: var(--success);
}

.badge.done {
  background-color: var(--success-dim);
  color: var(--success);
}

.badge.failed {
  background-color: var(--danger-dim);
  color: var(--danger);
}

.badge.pending {
  background-color: var(--surface-2);
  color: var(--text-muted);
}
</style>