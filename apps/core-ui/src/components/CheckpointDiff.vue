<template>
  <div class="checkpoint-diff-container">
    <div v-if="!checkpointA || !checkpointB" class="empty-state">
      <p>请选择两个检查点进行对比</p>
    </div>

    <div v-else class="diff-header">
      <div class="diff-info">
        <div class="checkpoint-info">
          <h3>检查点 A</h3>
          <span class="checkpoint-id">{{ checkpointA.checkpointId }}</span>
          <span class="checkpoint-time">{{ formatTime(checkpointA.createdAt) }}</span>
        </div>
        <div class="diff-arrow">vs</div>
        <div class="checkpoint-info">
          <h3>检查点 B</h3>
          <span class="checkpoint-id">{{ checkpointB.checkpointId }}</span>
          <span class="checkpoint-time">{{ formatTime(checkpointB.createdAt) }}</span>
        </div>
      </div>
      <div class="diff-actions">
        <button @click="swapCheckpoints" class="swap-btn">↔️ 交换</button>
        <button @click="copyDiff" class="copy-btn">复制对比结果</button>
      </div>
    </div>

    <div class="diff-content">
      <div class="diff-panel">
        <h4>完整对比 (JSON)</h4>
        <pre class="diff-json">{{ formattedDiff }}</pre>
      </div>
      <div class="diff-summary">
        <h4>变更摘要</h4>
        <div v-if="diffSummary.length === 0" class="no-changes">
          未检测到变更
        </div>
        <div v-else class="change-list">
          <div
            v-for="change in diffSummary"
            :key="change.path"
            class="change-item"
          >
            <div class="change-type-badge" :class="change.type as keyof typeof changeTypeLabels">
              {{ changeTypeLabels[change.type as keyof typeof changeTypeLabels] }}
            </div>
            <div class="change-path">{{ change.path }}</div>
            <div class="change-values">
              <span class="old-value" v-if="change.oldValue !== undefined">
                旧: {{ formatValue(change.oldValue) }}
              </span>
              <span class="new-value" v-if="change.newValue !== undefined">
                新: {{ formatValue(change.newValue) }}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { Checkpoint } from '../api';

interface Props {
  checkpointA: Checkpoint | null;
  checkpointB: Checkpoint | null;
}

const props = defineProps<Props>();
const emit = defineEmits<{
  swap: [];
}>();

const changeTypeLabels = {
  added: '✅ 新增',
  removed: '❌ 删除',
  modified: '🔄 修改',
  unchanged: '➡️ 不变'
};

const swapCheckpoints = () => {
  emit('swap');
};

const copyDiff = () => {
  navigator.clipboard.writeText(formattedDiff.value);
  alert('已复制对比结果');
};

const formatTime = (timestamp: string) => {
  try {
    return new Date(timestamp).toLocaleString('zh-CN');
  } catch (e) {
    return timestamp;
  }
};

const formatValue = (value: any): string => {
  if (typeof value === 'object' && value !== null) {
    return JSON.stringify(value, null, 2);
  }
  return String(value);
};

const deepDiff = (obj1: any, obj2: any, path: string[] = []): any[] => {
  const changes: any[] = [];
  const keys1 = new Set(Object.keys(obj1 || {}));
  const keys2 = new Set(Object.keys(obj2 || {}));

  // Check for added or modified keys
  for (const key of keys2) {
    const newPath = [...path, key];
    const fullPath = newPath.join('.');

    if (!keys1.has(key)) {
      changes.push({
        type: 'added',
        path: fullPath,
        newValue: obj2[key],
        oldValue: undefined
      });
    } else {
      const val1 = obj1[key];
      const val2 = obj2[key];

      if (typeof val1 === 'object' && val1 !== null && typeof val2 === 'object' && val2 !== null) {
        const nestedChanges = deepDiff(val1, val2, newPath);
        changes.push(...nestedChanges);
      } else if (val1 !== val2) {
        changes.push({
          type: 'modified',
          path: fullPath,
          oldValue: val1,
          newValue: val2
        });
      } else {
        changes.push({
          type: 'unchanged',
          path: fullPath,
          oldValue: val1,
          newValue: val2
        });
      }
    }
  }

  // Check for removed keys
  for (const key of keys1) {
    if (!keys2.has(key)) {
      const newPath = [...path, key];
      const fullPath = newPath.join('.');
      changes.push({
        type: 'removed',
        path: fullPath,
        oldValue: obj1[key],
        newValue: undefined
      });
    }
  }

  return changes;
};

const diffSummary = computed(() => {
  if (!props.checkpointA || !props.checkpointB) return [];

  const objA = { ...props.checkpointA };
  const objB = { ...props.checkpointB };

  // Remove createdAt from diff since it will always be different
  if ('createdAt' in objA) delete (objA as any).createdAt;
  if ('createdAt' in objB) delete (objB as any).createdAt;

  const changes = deepDiff(objA, objB);
  return changes.filter(change => change.type !== 'unchanged');
});

const formattedDiff = computed(() => {
  if (!props.checkpointA || !props.checkpointB) return '';
  const diff = deepDiff(props.checkpointA, props.checkpointB);
  return JSON.stringify(diff, null, 2);
});
</script>

<style scoped>
.checkpoint-diff-container {
  padding: 20px;
  background-color: var(--card-bg, #2d2d2d);
  border-radius: 8px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
}

.empty-state {
  text-align: center;
  padding: 40px;
  color: var(--text-secondary, #b0b0b0);
}

.diff-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 20px;
  padding-bottom: 16px;
  border-bottom: 1px solid var(--border-color, #404040);
}

.diff-info {
  display: flex;
  align-items: center;
  gap: 20px;
  flex-wrap: wrap;
}

.checkpoint-info {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 200px;
}

.checkpoint-info h3 {
  margin: 0;
  font-size: 16px;
  color: var(--text-primary, #ffffff);
}

.checkpoint-id {
  font-size: 13px;
  color: var(--accent-primary, #3498db);
  font-family: monospace;
}

.checkpoint-time {
  font-size: 12px;
  color: var(--text-secondary, #b0b0b0);
}

.diff-arrow {
  font-size: 24px;
  font-weight: bold;
  color: var(--text-secondary, #b0b0b0);
  padding: 0 20px;
}

.diff-actions {
  display: flex;
  gap: 8px;
}

.swap-btn, .copy-btn {
  padding: 8px 12px;
  border: none;
  border-radius: 4px;
  background-color: var(--bg-secondary, #404040);
  color: var(--text-primary, #ffffff);
  cursor: pointer;
  font-size: 13px;
}

.swap-btn:hover, .copy-btn:hover {
  background-color: var(--accent-hover, #34495e);
}

.diff-content {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 20px;
}

@media (max-width: 768px) {
  .diff-content {
    grid-template-columns: 1fr;
  }
}

.diff-panel {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.diff-panel h4 {
  margin: 0;
  font-size: 14px;
  color: var(--text-primary, #ffffff);
}

.diff-json {
  padding: 12px;
  background-color: var(--bg-secondary, #404040);
  border-radius: 4px;
  overflow-x: auto;
  font-size: 13px;
  color: var(--text-primary, #ffffff);
  white-space: pre-wrap;
  word-wrap: break-word;
  max-height: 500px;
}

.diff-summary {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.diff-summary h4 {
  margin: 0;
  font-size: 14px;
  color: var(--text-primary, #ffffff);
}

.no-changes {
  text-align: center;
  padding: 20px;
  color: var(--text-secondary, #b0b0b0);
}

.change-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.change-item {
  padding: 12px;
  background-color: var(--bg-secondary, #404040);
  border-radius: 4px;
  border-left: 4px solid var(--accent-primary, #3498db);
}

.change-type-badge {
  display: inline-block;
  padding: 2px 6px;
  border-radius: 4px;
  font-size: 12px;
  font-weight: 500;
  margin-bottom: 4px;
}

.change-type-badge.added {
  background-color: rgba(46, 204, 113, 0.2);
  color: #2ecc71;
}

.change-type-badge.removed {
  background-color: rgba(231, 76, 60, 0.2);
  color: #e74c3c;
}

.change-type-badge.modified {
  background-color: rgba(52, 152, 219, 0.2);
  color: #3498db;
}

.change-type-badge.unchanged {
  background-color: rgba(149, 165, 166, 0.2);
  color: #95a5a6;
}

.change-path {
  font-size: 13px;
  color: var(--text-primary, #ffffff);
  font-family: monospace;
  margin-bottom: 4px;
}

.change-values {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 12px;
}

.old-value {
  color: #e74c3c;
}

.new-value {
  color: #2ecc71;
}
</style>