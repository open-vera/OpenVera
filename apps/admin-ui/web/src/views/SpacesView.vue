<template>
  <div class="spaces-container">
    <div class="page-header">
      <h1>空间管理</h1>
      <div class="search-box">
        <input
          type="text"
          placeholder="搜索 scope ID..."
          v-model="searchQuery"
          class="search-input"
        />
      </div>
    </div>

    <div class="table-container">
      <table class="spaces-table">
        <thead>
          <tr>
            <th>Scope ID</th>
            <th>类型</th>
            <th>状态</th>
            <th>运行任务</th>
          </tr>
        </thead>
        <tbody>
          <template v-if="loading">
            <tr v-for="n in 5" :key="n" class="skeleton-row">
              <td><Skeleton width="200px" height="14px" /></td>
              <td><Skeleton width="60px" height="22px" border-radius="4px" /></td>
              <td><Skeleton width="60px" height="22px" border-radius="4px" /></td>
              <td><Skeleton width="100px" height="14px" /></td>
            </tr>
          </template>
          <template v-else>
          <tr
            v-for="space in filteredSpaces"
            :key="space.scope_id"
            @click="goToSpaceDetail(space.scope_id)"
            class="space-row"
          >
            <td class="scope-id">{{ space.scope_id }}</td>
            <td>
              <span class="badge" :class="space.type">
                {{ space.type === 'group' ? '👥 群组' : '👤 用户' }}
              </span>
            </td>
            <td>
              <span class="status-badge" :class="space.busy ? 'busy' : 'idle'">
                {{ space.busy ? '🔴 忙碌' : '🟢 空闲' }}
              </span>
            </td>
            <td>
              <span v-if="space.running_task" class="task-id">
                {{ space.running_task.task_id }}
              </span>
              <span v-else class="no-task">-</span>
            </td>
          </tr>
          </template>
        </tbody>
      </table>

      <div v-if="filteredSpaces.length === 0" class="empty-state">
        <p>没有找到匹配的空间</p>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { useRouter } from 'vue-router';
import { fetchSpaces, AdminSpaceDetail } from '../api';
import Skeleton from '../components/Skeleton.vue';

const router = useRouter();
const spaces = ref<AdminSpaceDetail[]>([]);
const searchQuery = ref('');
const loading = ref(true);

const filteredSpaces = computed(() => {
  if (!searchQuery.value) return spaces.value;

  const query = searchQuery.value.toLowerCase();
  return spaces.value.filter(space =>
    space.scope_id.toLowerCase().includes(query)
  );
});

const loadSpaces = async () => {
  try {
    loading.value = true;
    const data = await fetchSpaces();
    spaces.value = data;
  } catch (error) {
    console.error('Failed to load spaces:', error);
  } finally {
    loading.value = false;
  }
};

const goToSpaceDetail = (scopeId: string) => {
  router.push(`/spaces/${scopeId}`);
};

const refreshTimer = ref<ReturnType<typeof setInterval>>();

onMounted(() => {
  loadSpaces();
  refreshTimer.value = setInterval(loadSpaces, 30000);
});

onUnmounted(() => {
  clearInterval(refreshTimer.value);
});
</script>

<style scoped>
.spaces-container {
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

.search-input {
  padding: 8px 12px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background-color: var(--surface-2);
  color: var(--text);
  font-size: 14px;
  width: 300px;
}

.search-input:focus {
  outline: none;
  border-color: var(--accent);
}

.table-container {
  background-color: var(--surface);
  border-radius: 8px;
  overflow-x: auto;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
}

.spaces-table {
  width: 100%;
  border-collapse: collapse;
}

.spaces-table thead {
  background-color: var(--surface-2);
}

.spaces-table th {
  padding: 12px 16px;
  text-align: left;
  font-size: 14px;
  font-weight: 600;
  color: var(--text);
}

.spaces-table tbody tr {
  border-bottom: 1px solid var(--border);
  cursor: pointer;
  transition: background-color 0.2s;
}

.spaces-table tbody tr:hover {
  background-color: var(--surface-2);
}

.spaces-table td {
  padding: 12px 16px;
  font-size: 14px;
  color: var(--text);
}

.scope-id {
  font-family: monospace;
  font-size: 13px;
}

.badge {
  padding: 4px 8px;
  border-radius: 4px;
  font-size: 12px;
  font-weight: 500;
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
  padding: 4px 8px;
  border-radius: 4px;
  font-size: 12px;
  font-weight: 500;
}

.status-badge.busy {
  background-color: var(--danger-dim);
  color: var(--danger);
}

.status-badge.idle {
  background-color: var(--success-dim);
  color: var(--success);
}

.task-id {
  font-family: monospace;
  font-size: 12px;
  color: var(--accent);
}

.no-task {
  color: var(--text-muted);
  font-size: 13px;
}

.empty-state {
  padding: 40px;
  text-align: center;
  color: var(--text-muted);
}

.empty-state p {
  margin: 0;
  font-size: 16px;
}

.skeleton-row td {
  padding: 12px 16px;
}

@media (max-width: 768px) {
  .spaces-container {
    padding: 12px;
  }

  .page-header {
    flex-direction: column;
    gap: 12px;
    align-items: flex-start;
  }

  .search-input {
    width: 100%;
  }

  .spaces-table {
    min-width: 600px;
  }
}
</style>
