<template>
  <div class="memory-container">
    <div class="page-header">
      <h1>记忆管理</h1>
      <div class="controls">
        <div class="tier-selector">
          <button
            @click="setTierFilter(null)"
            :class="{ active: !currentTierFilter }"
          >
            全部
          </button>
          <button
            @click="setTierFilter('episodic')"
            :class="{ active: currentTierFilter === 'episodic' }"
          >
            情景记忆
          </button>
          <button
            @click="setTierFilter('semantic')"
            :class="{ active: currentTierFilter === 'semantic' }"
          >
            语义记忆
          </button>
          <button
            @click="setTierFilter('working')"
            :class="{ active: currentTierFilter === 'working' }"
          >
            工作记忆
          </button>
        </div>
        <div class="search-box">
          <input
            type="text"
            placeholder="搜索记忆内容或标签..."
            v-model="searchQuery"
            @input="handleSearch"
            class="search-input"
          />
        </div>
      </div>
    </div>

    <!-- 统计信息 -->
    <div v-if="snapshot" class="stats-bar">
      <div class="stat-item">
        <span class="stat-number">{{ snapshot.episodicCount }}</span>
        <span class="stat-label">情景记忆</span>
      </div>
      <div class="stat-item">
        <span class="stat-number">{{ snapshot.semanticCount }}</span>
        <span class="stat-label">语义记忆</span>
      </div>
      <div class="stat-item">
        <span class="stat-number">{{ snapshot.workingCount }}</span>
        <span class="stat-label">工作记忆</span>
      </div>
    </div>

    <div v-if="loading && entries.length === 0" class="skeleton-list">
      <div v-for="n in 4" :key="n" class="skeleton-card">
        <div class="skeleton-header">
          <Skeleton width="80px" height="20px" border-radius="4px" />
          <Skeleton width="70px" height="14px" />
          <Skeleton width="100px" height="14px" />
        </div>
        <Skeleton width="100%" height="14px" style="margin-bottom: 8px" />
        <Skeleton width="80%" height="14px" style="margin-bottom: 12px" />
        <div class="skeleton-tags">
          <Skeleton width="50px" height="20px" border-radius="4px" />
          <Skeleton width="60px" height="20px" border-radius="4px" />
          <Skeleton width="45px" height="20px" border-radius="4px" />
        </div>
      </div>
    </div>

    <div v-else-if="entries.length === 0" class="empty-state">
      <div class="empty-icon">🧠</div>
      <p class="empty-title">暂无记忆数据</p>
      <p class="empty-desc">记忆系统尚未初始化，运行一次 agent 后将自动填充</p>
    </div>

    <div v-else class="memory-list">
      <div
        v-for="entry in filteredEntries"
        :key="entry.id"
        class="memory-card"
        @click="toggleExpand(entry)"
      >
        <div class="memory-header">
          <div class="memory-meta">
            <span class="tier-badge" :class="entry.tier">
              {{ tierLabels[entry.tier] }}
            </span>
            <span class="importance-badge" :title="`重要度: ${entry.importance}/5`">
              <span v-for="n in 5" :key="n" class="star" :class="{ filled: n <= entry.importance }">{{ n <= entry.importance ? '★' : '☆' }}</span>
            </span>
            <span class="created-time">
              {{ formatTime(entry.createdAt) }}
            </span>
          </div>
          <div class="expand-icon">
            {{ expandedEntryId === entry.id ? '▼' : '▶' }}
          </div>
        </div>
        <div class="memory-content">
          <div class="content-preview">{{ getContentPreview(entry.content) }}</div>
          <div class="content-tags">
            <span v-for="tag in entry.tags" :key="tag" class="tag">
              {{ tag }}
            </span>
          </div>
        </div>
        <div v-if="expandedEntryId === entry.id" class="memory-expanded">
          <div class="full-content">
            <h4>完整内容:</h4>
            <pre>{{ entry.content }}</pre>
          </div>
          <div class="source-info">
            <label>来源:</label>
            <span class="source">{{ entry.source }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed, nextTick } from 'vue';
import { useRoute } from 'vue-router';
import { fetchMemory, type MemoryEntry, type MemorySnapshot } from '../api';
import Skeleton from '../components/Skeleton.vue';

const route = useRoute();
const runId = route.params.runId as string;

const entries = ref<MemoryEntry[]>([]);
const snapshot = ref<MemorySnapshot | null>(null);
const loading = ref(false);
const currentTierFilter = ref<string | null>(null);
const searchQuery = ref('');
const expandedEntryId = ref<string | null>(null);

const tierLabels = {
  episodic: '📝 情景记忆',
  semantic: '🧠 语义记忆',
  working: '💼 工作记忆'
};

const filteredEntries = computed(() => {
  let filtered = entries.value;

  // Apply tier filter
  if (currentTierFilter.value) {
    filtered = filtered.filter(entry => entry.tier === currentTierFilter.value);
  }

  // Apply search filter
  if (searchQuery.value) {
    const query = searchQuery.value.toLowerCase();
    filtered = filtered.filter(entry =>
      entry.content.toLowerCase().includes(query) ||
      entry.tags.some(tag => tag.toLowerCase().includes(query))
    );
  }

  // Sort by newest first
  return filtered.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
});

const loadMemoryData = async () => {
  loading.value = true;
  try {
    const response = await fetchMemory(runId, currentTierFilter.value as any, searchQuery.value);
    snapshot.value = response.snapshot;
    entries.value = response.entries;
  } catch (error) {
    console.error('Failed to load memory data:', error);
  } finally {
    loading.value = false;
  }
};

const setTierFilter = async (tier: string | null) => {
  currentTierFilter.value = tier;
  await nextTick();
  loadMemoryData();
};

const handleSearch = () => {
  loadMemoryData();
};

const toggleExpand = (entry: MemoryEntry) => {
  expandedEntryId.value = expandedEntryId.value === entry.id ? null : entry.id;
};

const getContentPreview = (content: string, maxLength: number = 150) => {
  if (content.length <= maxLength) return content;
  return content.substring(0, maxLength) + '...';
};

const formatTime = (timestamp: string) => {
  try {
    return new Date(timestamp).toLocaleString('zh-CN');
  } catch (e) {
    return timestamp;
  }
};

const refreshTimer = ref<ReturnType<typeof setInterval>>();

onMounted(() => {
  loadMemoryData();
  // 每10秒刷新一次
  refreshTimer.value = setInterval(loadMemoryData, 10000);
});

onUnmounted(() => {
  if (refreshTimer.value) {
    clearInterval(refreshTimer.value);
  }
});
</script>

<style scoped>
.memory-container {
  padding: 20px;
}

.page-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 20px;
  flex-wrap: wrap;
  gap: 16px;
}

.page-header h1 {
  font-size: 24px;
  color: var(--text);
  margin: 0;
  flex: 1;
  min-width: 200px;
}

.controls {
  display: flex;
  flex-direction: column;
  gap: 12px;
  flex: 2;
}

.tier-selector {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.tier-selector button {
  padding: 6px 12px;
  border: none;
  border-radius: 4px;
  background-color: var(--surface-2);
  color: var(--text);
  cursor: pointer;
  font-size: 13px;
  transition: all 0.2s;
}

.tier-selector button:hover {
  background-color: var(--surface-3);
}

.tier-selector button.active {
  background-color: var(--accent);
}

.search-input {
  padding: 8px 12px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background-color: var(--surface-2);
  color: var(--text);
  font-size: 14px;
  width: 100%;
}

.search-input:focus {
  outline: none;
  border-color: var(--accent);
}

.stats-bar {
  display: flex;
  gap: 24px;
  margin-bottom: 20px;
  padding: 16px;
  background-color: var(--surface);
  border-radius: 8px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
}

.stat-item {
  display: flex;
  flex-direction: column;
  align-items: center;
}

.stat-number {
  font-size: 24px;
  font-weight: bold;
  color: var(--accent);
}

.stat-label {
  font-size: 13px;
  color: var(--text-muted);
}

.loading-state, .empty-state {
  text-align: center;
  padding: 60px 40px;
  color: var(--text-muted);
}

.empty-icon {
  font-size: 48px;
  margin-bottom: 16px;
}

.empty-title {
  font-size: 16px;
  font-weight: 600;
  color: var(--text);
  margin: 0 0 8px 0;
}

.empty-desc {
  font-size: 13px;
  color: var(--text-muted);
  margin: 0;
  max-width: 360px;
  margin-left: auto;
  margin-right: auto;
  line-height: 1.5;
}

.skeleton-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.skeleton-card {
  background-color: var(--surface);
  border-radius: 8px;
  padding: 16px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
}

.skeleton-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
}

.skeleton-tags {
  display: flex;
  gap: 6px;
}

.memory-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.memory-card {
  background-color: var(--surface);
  border-radius: 8px;
  padding: 16px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
  cursor: pointer;
  transition: all 0.2s;
}

.memory-card:hover {
  transform: translateY(-2px);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5);
}

.memory-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
}

.memory-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.tier-badge {
  padding: 2px 6px;
  border-radius: 4px;
  font-size: 12px;
  font-weight: 500;
  color: white;
}

.tier-badge.episodic {
  background-color: var(--accent);
}

.tier-badge.semantic {
  background-color: var(--accent-dim);
}

.tier-badge.working {
  background-color: var(--warning);
}

.importance-badge {
  font-size: 12px;
  letter-spacing: 1px;
}

.star {
  color: var(--text-muted);
  font-size: 11px;
}

.star.filled {
  color: var(--warning);
}

.created-time {
  font-size: 12px;
  color: var(--text-muted);
}

.expand-icon {
  font-size: 16px;
  color: var(--text-muted);
}

.memory-content {
  margin-bottom: 12px;
}

.content-preview {
  font-size: 14px;
  color: var(--text);
  margin-bottom: 8px;
  line-height: 1.5;
}

.content-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.tag {
  padding: 2px 6px;
  background-color: var(--surface-2);
  border-radius: 4px;
  font-size: 12px;
  color: var(--text-muted);
}

.memory-expanded {
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--border);
}

.full-content {
  margin-bottom: 12px;
}

.full-content h4 {
  margin: 0 0 8px 0;
  font-size: 14px;
  color: var(--text);
}

.full-content pre {
  padding: 12px;
  background-color: var(--surface-2);
  border-radius: 4px;
  overflow-x: auto;
  font-size: 13px;
  color: var(--text);
  white-space: pre-wrap;
  word-wrap: break-word;
}

.source-info {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.source-info label {
  font-size: 13px;
  color: var(--text-muted);
}

.source-info .source {
  font-size: 13px;
  color: var(--accent);
  font-family: monospace;
}
</style>