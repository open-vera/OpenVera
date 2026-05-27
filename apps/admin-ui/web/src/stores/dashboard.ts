import { defineStore } from 'pinia';
import {
  fetchOverview,
  fetchContainers,
  fetchResources,
  fetchHeatmap,
  AdminOverview,
  AdminContainer,
  AdminResource,
  HeatmapData
} from '../api';

export interface DashboardState {
  overview: AdminOverview | null;
  containers: AdminContainer[];
  resources: AdminResource[];
  heatmap: HeatmapData[];
  loading: boolean;
  error: string | null;
}

export const useDashboardStore = defineStore('dashboard', {
  state: (): DashboardState => ({
    overview: null,
    containers: [],
    resources: [],
    heatmap: [],
    loading: false,
    error: null
  }),

  getters: {
    totalSpaces: (state) => state.overview?.total_spaces || 0,
    activeTasks: (state) => state.overview?.active_tasks || 0,
    totalContainers: (state) => state.containers.length,
    activeContainers: (state) => state.containers.filter(c => c.busy).length,
    idleContainers: (state) => state.containers.filter(c => !c.busy).length,
    containerDistribution: (state) => {
      const total = state.containers.length;
      if (total === 0) return { active: 0, idle: 0, activePercent: 0 };
      const active = state.containers.filter(c => c.busy).length;
      return {
        active,
        idle: total - active,
        activePercent: Math.round((active / total) * 100)
      };
    },
    cpuUsage: (state) => {
      const cpu = state.resources.find(r => r.type === 'cpu');
      return cpu?.usage || 0;
    },
    memoryUsage: (state) => {
      const memory = state.resources.find(r => r.type === 'memory');
      return memory?.usage || 0;
    },
    diskUsage: (state) => {
      const disk = state.resources.find(r => r.type === 'disk');
      return disk?.usage || 0;
    },
  },

  actions: {
    async fetchAll() {
      this.loading = true;
      this.error = null;
      try {
        // 并行加载所有数据
        const [overview, containers, resources, heatmap] = await Promise.all([
          fetchOverview(),
          fetchContainers(),
          fetchResources(),
          fetchHeatmap()
        ]);

        this.overview = overview;
        this.containers = containers;
        this.resources = resources;
        this.heatmap = heatmap;
      } catch (error) {
        this.error = error instanceof Error ? error.message : 'Failed to fetch dashboard data';
        console.error('Failed to fetch dashboard data:', error);
      } finally {
        this.loading = false;
      }
    },

    autoRefresh(intervalMs: number = 30000) {
      // 立即执行一次
      this.fetchAll();

      // 设置定时刷新
      const intervalId = setInterval(() => {
        this.fetchAll();
      }, intervalMs);

      // 返回清除函数
      return () => clearInterval(intervalId);
    },

    // 单独加载方法
    async loadOverview() {
      try {
        const overview = await fetchOverview();
        this.overview = overview;
      } catch (error) {
        console.error('Failed to load overview:', error);
      }
    },

    async loadContainers() {
      try {
        const containers = await fetchContainers();
        this.containers = containers;
      } catch (error) {
        console.error('Failed to load containers:', error);
      }
    },

    async loadResources() {
      try {
        const resources = await fetchResources();
        this.resources = resources;
      } catch (error) {
        console.error('Failed to load resources:', error);
      }
    },

    async loadHeatmap() {
      try {
        const heatmap = await fetchHeatmap();
        this.heatmap = heatmap;
      } catch (error) {
        console.error('Failed to load heatmap:', error);
      }
    }
  }
});
