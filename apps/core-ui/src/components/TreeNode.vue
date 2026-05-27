<template>
  <div class="tree-node">
    <div class="node-content" :style="{ paddingLeft: `${depth * 20 + 8}px` }">
      <div v-if="node.children && node.children.length > 0" class="expand-btn" @click="toggleExpand">
        {{ isExpanded ? '▼' : '▶' }}
      </div>
      <div v-else class="expand-placeholder"></div>
      <div class="node-item" @click="selectNode">
        <div class="node-info">
          <span class="node-task-id">{{ node.taskId }}</span>
          <span class="node-agent-type">{{ node.agentType }}</span>
          <span class="node-status-badge" :class="node.status">
            {{ statusMap[node.status] || node.status }}
          </span>
        </div>
        <div class="node-meta">
          <span v-if="node.dependsOn && node.dependsOn.length > 0" class="depends-on-badge">
            依赖 {{ node.dependsOn.length }} 个任务
          </span>
          <span v-if="node.children && node.children.length > 0" class="children-count">
            {{ node.children.length }} 个子节点
          </span>
        </div>
      </div>
    </div>
    <div v-if="isExpanded && node.children" class="node-children">
      <TreeNode
        v-for="child in node.children"
        :key="child.taskId"
        :node="child"
        :depth="depth + 1"
        @expand="$emit('expand', child.taskId)"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue';
import type { SubagentCallTreeNode } from '../api';

interface Props {
  node: SubagentCallTreeNode;
  depth: number;
}

const props = defineProps<Props>();
const emit = defineEmits<{
  expand: [nodeId: string];
}>();

const expanded = ref(false);

const isExpanded = computed(() => {
  return expanded.value;
});

const toggleExpand = () => {
  expanded.value = !expanded.value;
  emit('expand', props.node.taskId);
};

const selectNode = () => {
  // 可以在这里发出选中节点的事件，或者直接在组件内处理
  console.log('Selected node:', props.node.taskId);
};

const statusMap = {
  pending: '⏳ 待执行',
  running: '🟢 运行中',
  done: '✅ 已完成',
  failed: '❌ 失败'
};
</script>

<style scoped>
.tree-node {
  margin-bottom: 8px;
}

.node-content {
  display: flex;
  align-items: center;
  cursor: pointer;
  transition: all 0.2s;
  border-radius: 4px;
}

.node-content:hover {
  background-color: var(--surface-2);
}

.expand-btn, .expand-placeholder {
  width: 20px;
  text-align: center;
  font-size: 12px;
  color: var(--text-muted);
}

.node-item {
  flex: 1;
  padding: 8px 12px;
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.node-info {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.node-task-id {
  font-size: 13px;
  font-weight: 500;
  color: var(--text);
  font-family: monospace;
}

.node-agent-type {
  font-size: 12px;
  color: var(--text-muted);
}

.node-status-badge {
  padding: 2px 6px;
  border-radius: 4px;
  font-size: 12px;
  font-weight: 500;
  color: white;
}

.node-status-badge.running {
  background-color: var(--success);
}

.node-status-badge.done {
  background-color: var(--success);
}

.node-status-badge.failed {
  background-color: var(--danger);
}

.node-status-badge.pending {
  background-color: var(--text-muted);
}

.node-meta {
  display: flex;
  gap: 8px;
  align-items: center;
}

.depends-on-badge, .children-count {
  font-size: 11px;
  padding: 2px 4px;
  background-color: var(--surface-2);
  border-radius: 3px;
  color: var(--text-muted);
}

.node-children {
  margin-left: 0;
}
</style>