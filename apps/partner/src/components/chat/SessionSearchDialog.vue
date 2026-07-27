<script setup lang="ts">
import { computed } from "vue";
import { useQuickOpenStore } from "@/stores/quick-open";
import { useSettingsStore } from "@/stores/settings";

const quickOpen = useQuickOpenStore();
const settings = useSettingsStore();

const title = computed(() =>
  settings.locale === "en" ? "Search files & sessions" : "搜索文件与会话",
);

function openGlobalSearch() {
  quickOpen.show();
}
</script>

<template>
  <div class="session-search">
    <button
      type="button"
      class="search-button"
      :title="title"
      :aria-label="title"
      @click="openGlobalSearch"
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="11" cy="11" r="7" />
        <path d="m16.5 16.5 3.5 3.5" />
      </svg>
    </button>
  </div>
</template>

<style scoped>
.session-search {
  position: relative;
  flex-shrink: 0;
}

.search-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border: none;
  border-radius: 6px;
  padding: 0;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
}

.search-button:hover {
  background: color-mix(in srgb, var(--surface-hover) 72%, transparent);
  color: var(--text);
}

.search-button svg {
  width: 18px;
  height: 18px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.8;
  stroke-linecap: round;
  stroke-linejoin: round;
}
</style>
