<template>
  <div class="settings-container">
    <div class="page-header">
      <h1>系统设置</h1>
    </div>

    <div class="settings-grid">
      <!-- LLM 配置卡片 -->
      <div class="settings-card">
        <h2>LLM 配置</h2>
        <div class="setting-item">
          <label>API Key:</label>
          <div class="value-container">
            <span class="api-key">{{ maskedApiKey }}</span>
            <button @click="toggleApiKey" class="toggle-btn">
              {{ showApiKey ? '隐藏' : '显示' }}
            </button>
          </div>
        </div>
        <div class="setting-item">
          <label>模型:</label>
          <span class="value">{{ llmModel }}</span>
        </div>
        <div class="setting-item">
          <label>Base URL:</label>
          <span class="value">{{ baseUrl }}</span>
        </div>
      </div>

      <!-- 系统信息卡片 -->
      <div class="settings-card">
        <h2>系统信息</h2>
        <div class="setting-item">
          <label>运行时间:</label>
          <span class="value">{{ uptime }}</span>
        </div>
        <div class="setting-item">
          <label>磁盘用量:</label>
          <span class="value">{{ diskUsage }}</span>
        </div>
        <div class="setting-item">
          <label>内存使用:</label>
          <span class="value">{{ memoryUsage }}</span>
        </div>
        <div class="setting-item">
          <label>CPU 核心数:</label>
          <span class="value">{{ cpuCores }}</span>
        </div>
      </div>

      <!-- 版本信息 -->
      <div class="settings-card full-width">
        <h2>版本信息</h2>
        <div class="version-info">
          <div class="version-item">
            <label>OpenVera 版本:</label>
            <span class="value">{{ veraVersion }}</span>
          </div>
          <div class="version-item">
            <label>Vue 版本:</label>
            <span class="value">{{ vueVersion }}</span>
          </div>
          <div class="version-item">
            <label>构建时间:</label>
            <span class="value">{{ buildTime }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';

// 状态
const showApiKey = ref(false);
const maskedApiKey = ref('***************************');
const llmModel = ref('claude-sonnet-4-6');
const baseUrl = ref('https://api.anthropic.com/v1');
const uptime = ref('0d 0h 0m');
const diskUsage = ref('0%');
const memoryUsage = ref('0%');
const cpuCores = ref('4');
const veraVersion = ref('1.0.0');
const vueVersion = ref('3.5.0');
const buildTime = ref(new Date().toLocaleString('zh-CN'));

// 切换 API Key 显示
const toggleApiKey = () => {
  showApiKey.value = !showApiKey.value;
  // 实际项目中应该从 API 获取真实的 API Key 并显示/隐藏
  if (showApiKey.value) {
    maskedApiKey.value = 'sk-***************************';
  } else {
    maskedApiKey.value = '***************************';
  }
};

// 加载系统信息
const loadSystemInfo = () => {
  try {
    // 模拟获取系统信息
    const now = new Date();
    const uptimeMs = now.getTime() - new Date('2026-05-27T00:00:00').getTime();
    const days = Math.floor(uptimeMs / (1000 * 60 * 60 * 24));
    const hours = Math.floor((uptimeMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    const minutes = Math.floor((uptimeMs % (1000 * 60 * 60)) / (1000 * 60));
    uptime.value = `${days}d ${hours}h ${minutes}m`;

    // 模拟资源使用
    diskUsage.value = `${Math.floor(Math.random() * 50 + 30)}%`;
    memoryUsage.value = `${Math.floor(Math.random() * 40 + 20)}%`;
  } catch (error) {
    console.error('Failed to load system info:', error);
  }
};

onMounted(() => {
  loadSystemInfo();
});
</script>

<style scoped>
.settings-container {
  padding: 20px;
}

.page-header {
  margin-bottom: 20px;
}

.page-header h1 {
  font-size: 24px;
  color: var(--text);
  margin: 0;
}

.settings-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(400px, 1fr));
  gap: 20px;
}

.settings-card {
  background-color: var(--surface);
  padding: 20px;
  border-radius: 8px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
}

.settings-card.full-width {
  grid-column: 1 / -1;
}

.settings-card h2 {
  margin: 0 0 20px 0;
  font-size: 18px;
  color: var(--text);
}

.setting-item {
  margin-bottom: 16px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.setting-item:last-child {
  margin-bottom: 0;
}

.setting-item label {
  font-size: 13px;
  color: var(--text-muted);
}

.value-container {
  display: flex;
  align-items: center;
  gap: 10px;
}

.api-key {
  flex: 1;
  padding: 6px 8px;
  background-color: var(--surface-2);
  border-radius: 4px;
  font-family: monospace;
  font-size: 13px;
  color: var(--text);
}

.toggle-btn {
  padding: 6px 12px;
  background-color: var(--accent);
  color: white;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  font-size: 13px;
}

.toggle-btn:hover {
  opacity: 0.9;
}

.value {
  padding: 6px 8px;
  background-color: var(--surface-2);
  border-radius: 4px;
  font-size: 13px;
  color: var(--text);
  font-family: monospace;
}

.version-info {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.version-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.version-item label {
  font-size: 14px;
  color: var(--text-muted);
}

.version-item .value {
  background: transparent;
  padding: 0;
  font-family: inherit;
  font-size: 14px;
  color: var(--text);
}
</style>
