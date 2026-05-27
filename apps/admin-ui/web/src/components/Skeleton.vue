<template>
  <div
    class="skeleton"
    :style="{
      width: width,
      height: height,
      borderRadius: borderRadius
    }"
  />
</template>

<script setup lang="ts">
withDefaults(defineProps<{
  width?: string;
  height?: string;
  borderRadius?: string;
}>(), {
  width: '100%',
  height: '16px',
  borderRadius: '4px'
});
</script>

<style scoped>
.skeleton {
  background: linear-gradient(
    90deg,
    var(--surface-2) 25%,
    var(--surface-3) 50%,
    var(--surface-2) 75%
  );
  background-size: 200% 100%;
  animation: skeleton-pulse 1.5s ease-in-out infinite;
}

@keyframes skeleton-pulse {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}
</style>
