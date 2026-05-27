<template>
  <div class="dashboard-container">
    <!-- 顶部指标卡片 -->
    <div class="metrics-grid">
      <template v-if="loading">
        <div v-for="n in 4" :key="n" class="metric-card">
          <Skeleton width="48px" height="48px" border-radius="8px" />
          <div class="metric-content">
            <Skeleton width="60px" height="14px" />
            <Skeleton width="80px" height="28px" style="margin-top: 6px" />
          </div>
        </div>
      </template>
      <template v-else>
        <div class="metric-card">
          <div class="metric-icon">📦</div>
          <div class="metric-content">
            <div class="metric-label">总空间数</div>
            <div class="metric-value">{{ metrics.totalSpaces }}</div>
          </div>
        </div>
        <div class="metric-card">
          <div class="metric-icon">🚀</div>
          <div class="metric-content">
            <div class="metric-label">运行任务</div>
            <div class="metric-value">{{ metrics.activeTasks }}</div>
          </div>
        </div>
        <div class="metric-card">
          <div class="metric-icon">💻</div>
          <div class="metric-content">
            <div class="metric-label">容器总数</div>
            <div class="metric-value">{{ metrics.totalContainers }}</div>
          </div>
        </div>
        <div class="metric-card">
          <div class="metric-icon">💰</div>
          <div class="metric-content">
            <div class="metric-label">今日花费</div>
            <div class="metric-value">${{ metrics.todayCost }}</div>
          </div>
        </div>
      </template>
    </div>

    <!-- 图表区域 -->
    <div class="charts-grid">
      <!-- 容器分布饼图 -->
      <div class="chart-card">
        <h3>容器分布</h3>
        <div class="donut-chart" :style="{ background: donutGradient }">
          <div class="donut-inner">
            <span class="donut-percent">{{ containerDistribution.activePercent }}%</span>
          </div>
        </div>
        <div class="chart-legend">
          <span class="legend-item active">活跃: {{ containerDistribution.active }}</span>
          <span class="legend-item idle">空闲: {{ containerDistribution.idle }}</span>
        </div>
      </div>

      <!-- CPU/内存进度条 -->
      <div class="chart-card">
        <h3>资源使用</h3>
        <div class="resource-progress">
          <div class="progress-label">
            <span>CPU</span>
            <span>{{ resourceUsage.cpu }}%</span>
          </div>
          <div class="progress-bar">
            <div class="progress-fill cpu" :style="{ width: resourceUsage.cpu + '%' }"></div>
          </div>
        </div>
        <div class="resource-progress">
          <div class="progress-label">
            <span>内存</span>
            <span>{{ resourceUsage.memory }}%</span>
          </div>
          <div class="progress-bar">
            <div class="progress-fill memory" :style="{ width: resourceUsage.memory + '%' }"></div>
          </div>
        </div>
      </div>

      <!-- 24h热度分布柱状图 -->
      <div class="chart-card full-width">
        <h3>24小时容器热度</h3>
        <div class="heatmap-chart">
          <div class="heatmap-bar" v-for="data in heatmapData" :key="data.hour">
            <div class="tooltip">{{ data.hour }}:00 - {{ data.active }} 活跃, {{ data.idle }} 空闲</div>
            <div class="bar-container">
              <div class="bar active" :style="{ height: (data.active / maxCount * 100) + '%' }"></div>
              <div class="bar idle" :style="{ height: (data.idle / maxCount * 100) + '%' }"></div>
            </div>
            <span class="bar-label">{{ data.hour }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed } from 'vue';
import { fetchOverview, fetchResources, fetchHeatmap, fetchContainers } from '../api';
import Skeleton from '../components/Skeleton.vue';

interface MetricData {
  totalSpaces: number;
  activeTasks: number;
  totalContainers: number;
  todayCost: number;
}

interface ContainerDistribution {
  active: number;
  idle: number;
  activePercent: number;
}

interface ResourceUsage {
  cpu: number;
  memory: number;
}

const metrics = ref<MetricData>({
  totalSpaces: 0,
  activeTasks: 0,
  totalContainers: 0,
  todayCost: 0
});

const containerDistribution = ref<ContainerDistribution>({
  active: 0,
  idle: 0,
  activePercent: 0
});

const resourceUsage = ref<ResourceUsage>({
  cpu: 0,
  memory: 0
});

const heatmapData = ref<Array<{ hour: number; active: number; idle: number }>>([]);
const loading = ref(true);

const maxCount = computed(() => {
  if (heatmapData.value.length === 0) return 1;
  return Math.max(...heatmapData.value.flatMap(d => [d.active, d.idle]));
});

const donutGradient = computed(() => {
  const pct = containerDistribution.value.activePercent;
  return `conic-gradient(var(--accent) 0% ${pct}%, var(--surface-2) ${pct}% 100%)`;
});

const loadData = async () => {
  try {
    // 加载概览数据
    loading.value = true;
    const overview = await fetchOverview();
    metrics.value = {
      totalSpaces: overview.total_spaces,
      activeTasks: overview.active_tasks,
      totalContainers: overview.total_containers,
      todayCost: Math.round(overview.resource_usage.disk * 100) / 100 // 模拟花费
    };

    // 加载资源数据
    const resources = await fetchResources();
    const cpuResource = resources.find(r => r.type === 'cpu');
    const memoryResource = resources.find(r => r.type === 'memory');
    if (cpuResource) resourceUsage.value.cpu = cpuResource.usage;
    if (memoryResource) resourceUsage.value.memory = memoryResource.usage;

    // 计算容器分布
    const allContainers = await fetchContainers();
    const activeContainers = allContainers.filter(c => c.busy).length;
    const idleContainers = allContainers.length - activeContainers;
    containerDistribution.value = {
      active: activeContainers,
      idle: idleContainers,
      activePercent: allContainers.length > 0 ? Math.round((activeContainers / allContainers.length) * 100) : 0
    };

    // 加载热度数据
    const heatmap = await fetchHeatmap();
    heatmapData.value = heatmap;
  } catch (error) {
    console.error('Failed to load dashboard data:', error);
  } finally {
    loading.value = false;
  }
};

const refreshTimer = ref<ReturnType<typeof setInterval>>();

onMounted(() => {
  loadData();
  refreshTimer.value = setInterval(loadData, 30000);
});

onUnmounted(() => {
  clearInterval(refreshTimer.value);
});
</script>

<style scoped>
.dashboard-container {
  padding: 20px;
}

.metrics-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
  gap: 20px;
  margin-bottom: 30px;
}

.metric-card {
  background-color: var(--surface);
  padding: 20px;
  border-radius: 8px;
  display: flex;
  align-items: center;
  gap: 15px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
}

.metric-icon {
  font-size: 36px;
}

.metric-content {
  flex: 1;
}

.metric-label {
  font-size: 14px;
  color: var(--text-muted);
  margin-bottom: 5px;
}

.metric-value {
  font-size: 28px;
  font-weight: bold;
  color: var(--text);
}

.charts-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(400px, 1fr));
  gap: 20px;
}

.chart-card {
  background-color: var(--surface);
  padding: 20px;
  border-radius: 8px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
}

.chart-card.full-width {
  grid-column: 1 / -1;
}

.chart-card h3 {
  margin: 0 0 20px 0;
  font-size: 18px;
  color: var(--text);
}

/* 环形图 */
.donut-chart {
  width: 150px;
  height: 150px;
  margin: 0 auto 20px;
  position: relative;
  border-radius: 50%;
}

.donut-inner {
  width: 100%;
  height: 100%;
  border-radius: 50%;
  background-color: var(--surface);
  display: flex;
  align-items: center;
  justify-content: center;
  transform: scale(0.85);
}

.donut-percent {
  font-size: 24px;
  font-weight: bold;
  color: var(--text);
}

.chart-legend {
  display: flex;
  justify-content: center;
  gap: 20px;
  font-size: 14px;
  color: var(--text-muted);
}

.legend-item.active {
  color: var(--accent);
}

.legend-item.idle {
  color: var(--text-muted);
}

/* 资源进度条 */
.resource-progress {
  margin-bottom: 20px;
}

.progress-label {
  display: flex;
  justify-content: space-between;
  margin-bottom: 8px;
  font-size: 14px;
  color: var(--text-muted);
}

.progress-bar {
  height: 12px;
  background-color: var(--surface-2);
  border-radius: 6px;
  overflow: hidden;
}

.progress-fill {
  height: 100%;
  border-radius: 6px;
  transition: width 0.3s ease;
}

.progress-fill.cpu {
  background-color: var(--accent);
}

.progress-fill.memory {
  background-color: var(--danger);
}

/* 热度图 */
.heatmap-chart {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  height: 200px;
  gap: 8px;
}

.heatmap-bar {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  position: relative;
}

.heatmap-bar .tooltip {
  position: absolute;
  bottom: calc(100% + 8px);
  left: 50%;
  transform: translateX(-50%);
  background-color: var(--surface-3);
  color: var(--text);
  padding: 6px 10px;
  border-radius: 4px;
  font-size: 12px;
  white-space: nowrap;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.15s ease;
  border: 1px solid var(--border);
  z-index: 10;
}

.heatmap-bar:hover .tooltip {
  opacity: 1;
}

.bar-container {
  height: 150px;
  width: 100%;
  background-color: var(--surface-2);
  border-radius: 4px;
  display: flex;
  align-items: flex-end;
  gap: 2px;
  padding: 4px;
}

.bar {
  flex: 1;
  border-radius: 2px;
}

.bar.active {
  background-color: var(--accent);
}

.bar.idle {
  background-color: var(--text-muted);
}

.bar-label {
  font-size: 12px;
  color: var(--text-muted);
}

@media (max-width: 768px) {
  .dashboard-container {
    padding: 12px;
  }

  .metrics-grid {
    grid-template-columns: 1fr;
    gap: 12px;
  }

  .charts-grid {
    grid-template-columns: 1fr;
    gap: 12px;
  }

  .heatmap-chart {
    overflow-x: auto;
    padding-bottom: 8px;
  }

  .heatmap-bar {
    min-width: 24px;
  }
}
</style>
