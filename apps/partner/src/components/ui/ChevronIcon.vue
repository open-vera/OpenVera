<script setup lang="ts">
/**
 * Shared expand/collapse chevron (same path as file tree / session tree).
 * - expanded=false → points right (collapsed)
 * - expanded=true → points down
 * - flipped=true → rotate 180° (e.g. open dropdown)
 */
withDefaults(
  defineProps<{
    expanded?: boolean;
    flipped?: boolean;
  }>(),
  {
    expanded: false,
    flipped: false,
  },
);
</script>

<template>
  <svg
    class="chevron-icon"
    :class="{ expanded, flipped }"
    viewBox="0 0 20 20"
    aria-hidden="true"
  >
    <path d="M5 8l5 5 5-5" />
  </svg>
</template>

<style scoped>
.chevron-icon {
  width: 1em;
  height: 1em;
  flex-shrink: 0;
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
  transform: rotate(-90deg);
  transition: transform 120ms ease;
}

.chevron-icon.expanded {
  transform: rotate(0deg);
}

.chevron-icon.flipped {
  transform: rotate(180deg);
}

.chevron-icon.expanded.flipped {
  transform: rotate(180deg);
}
</style>
