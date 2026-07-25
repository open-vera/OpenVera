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
  height: 48px;
  padding: 0 12px;
  border: none;
  border-radius: 0;
  background: transparent;
  color: var(--text-muted);
  font-size: 13px;
  font-weight: 500;
  text-align: left;
  cursor: pointer;
}

.tab:hover {
  background: color-mix(
    in srgb,
    var(--surface-hover-solid, var(--surface-hover)) 78%,
    transparent
  );
  color: var(--text);
}

.tab:hover::before {
  content: "";
  position: absolute;
  right: 8px;
  bottom: 0;
  left: 8px;
  z-index: 1;
  height: 2px;
  background: color-mix(in srgb, var(--text-muted) 55%, transparent);
}

.tab.active {
  background: transparent;
  color: var(--text);
  font-weight: 600;
}

.tab.active:hover {
  background: color-mix(
    in srgb,
    var(--surface-hover-solid, var(--surface-hover)) 55%,
    transparent
  );
}

.tab.active:hover::before {
  display: none;
}

.tab.active::after {
  content: "";
  position: absolute;
  right: 8px;
  bottom: 0;
  left: 8px;
  z-index: 1;
  height: 2px;
  border-radius: 0;
  background: var(--tab-indicator, var(--accent));
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
