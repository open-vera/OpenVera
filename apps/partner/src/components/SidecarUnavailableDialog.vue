<script setup lang="ts">
import { open } from "@tauri-apps/plugin-shell";
import { computed } from "vue";

const props = defineProps<{
  visible: boolean;
  error?: string;
  needsNodeInstall?: boolean;
}>();

const emit = defineEmits<{
  dismiss: [];
}>();

const title = computed(() =>
  props.needsNodeInstall ? "需要安装 Node.js" : "Sidecar 未就绪",
);

const message = computed(() => {
  if (props.error?.trim()) return props.error;
  if (props.needsNodeInstall) {
    return "此版本 Partner 需要系统已安装 Node.js 20 或更高版本。";
  }
  return "Partner 后台服务未能启动，请重启应用。";
});

async function openNodeDownload() {
  await open("https://nodejs.org/");
}
</script>

<template>
  <div v-if="visible" class="sidecar-dialog-backdrop" @click.self="emit('dismiss')">
    <section class="sidecar-dialog" role="alertdialog" aria-modal="true" :aria-label="title">
      <header class="sidecar-dialog-header">
        <h2>{{ title }}</h2>
        <button type="button" class="sidecar-dialog-close" aria-label="关闭" @click="emit('dismiss')">
          ×
        </button>
      </header>
      <p class="sidecar-dialog-message">{{ message }}</p>
      <div class="sidecar-dialog-actions">
        <button
          v-if="needsNodeInstall"
          type="button"
          class="sidecar-dialog-primary"
          @click="openNodeDownload"
        >
          打开 Node.js 下载页
        </button>
        <button type="button" class="sidecar-dialog-secondary" @click="emit('dismiss')">
          知道了
        </button>
      </div>
    </section>
  </div>
</template>

<style scoped>
.sidecar-dialog-backdrop {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: rgba(0, 0, 0, 0.45);
}

.sidecar-dialog {
  width: min(480px, 100%);
  border-radius: 12px;
  background: var(--surface-elevated-solid, var(--surface-solid, var(--surface)));
  -webkit-backdrop-filter: none;
  backdrop-filter: none;
  border: 1px solid var(--border);
  color: var(--text);
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.35);
}

.sidecar-dialog-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 16px 18px 0;
}

.sidecar-dialog-header h2 {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
}

.sidecar-dialog-close {
  border: none;
  background: transparent;
  color: inherit;
  font-size: 22px;
  line-height: 1;
  cursor: pointer;
  opacity: 0.7;
}

.sidecar-dialog-close:hover {
  opacity: 1;
}

.sidecar-dialog-message {
  margin: 12px 18px 0;
  white-space: pre-wrap;
  line-height: 1.5;
  color: var(--text-muted);
}

.sidecar-dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 18px;
}

.sidecar-dialog-primary,
.sidecar-dialog-secondary {
  border-radius: 8px;
  padding: 8px 14px;
  font-size: 13px;
  cursor: pointer;
}

.sidecar-dialog-primary {
  border: none;
  background: var(--accent);
  color: var(--accent-text);
}

.sidecar-dialog-secondary {
  border: 1px solid var(--border);
  background: transparent;
  color: inherit;
}
</style>
