<script setup lang="ts">
defineProps<{
  title: string;
  active?: boolean;
  dirty?: boolean;
}>();

const emit = defineEmits<{
  select: [];
  close: [];
}>();
</script>

<template>
  <button
    type="button"
    class="tab"
    :class="{ active }"
    @click="emit('select')"
  >
    <span class="title">
      <span v-if="dirty" class="dirty-dot" aria-label="未保存" />
      <span>{{ title }}</span>
    </span>
    <span class="close" @click.stop="emit('close')">×</span>
  </button>
</template>

<style scoped>
.tab {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  flex: 0 0 auto;
  min-width: max-content;
  height: 40px;
  padding: 0 10px 0 12px;
  border: none;
  border-radius: 0;
  background: transparent;
  color: var(--text-muted);
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}

.tab:hover {
  background: color-mix(in srgb, var(--surface-hover) 72%, transparent);
  color: var(--text);
}

.tab.active {
  background: var(--surface-elevated);
  color: inherit;
}

.title {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex: 0 0 auto;
  min-width: max-content;
}

.title span:last-child {
  white-space: nowrap;
}

.dirty-dot {
  width: 7px;
  height: 7px;
  flex-shrink: 0;
  border-radius: 999px;
  background: var(--accent);
}

.close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  flex-shrink: 0;
  border-radius: 4px;
  opacity: 0.6;
}

.close:hover {
  background: var(--surface-hover);
  opacity: 1;
}
</style>
