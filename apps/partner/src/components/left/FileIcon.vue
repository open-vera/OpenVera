<script setup lang="ts">
import { computed } from "vue";
import { fileIconForPath } from "@/utils/file-icons";

const props = defineProps<{
  path: string;
  isDir?: boolean;
}>();

const icon = computed(() => fileIconForPath(props.path, props.isDir));
</script>

<template>
  <span
    class="file-icon"
    :class="{ folder: icon.isDir }"
    :style="{ '--icon-color': icon.color }"
    aria-hidden="true"
  >
    <svg v-if="icon.isDir" viewBox="0 0 18 16" class="folder-svg">
      <path d="M1.5 4.6h5.2l1.2 1.4h8.6v7.3a1.2 1.2 0 0 1-1.2 1.2H2.7a1.2 1.2 0 0 1-1.2-1.2z" />
      <path d="M1.7 3.1c0-.7.5-1.2 1.2-1.2h3.8l1.2 1.4h7.2c.7 0 1.2.5 1.2 1.2v1.4H1.7z" />
    </svg>
    <template v-else>
      <svg viewBox="0 0 16 18" class="file-svg">
        <path d="M2.5 1.5h7.1l3.9 3.9v11.1h-11z" />
        <path d="M9.5 1.8v4h4" />
      </svg>
      <span class="file-label">{{ icon.label }}</span>
    </template>
  </span>
</template>

<style scoped>
.file-icon {
  --icon-color: #56b6c2;
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  flex-shrink: 0;
  color: var(--icon-color);
}

.folder-svg,
.file-svg {
  width: 18px;
  height: 18px;
  display: block;
}

.folder-svg path {
  fill: color-mix(in srgb, var(--icon-color) 72%, transparent);
  stroke: color-mix(in srgb, var(--icon-color) 90%, var(--text-muted));
  stroke-width: 1;
  stroke-linejoin: round;
}

.file-svg path {
  fill: color-mix(in srgb, var(--icon-color) 10%, transparent);
  stroke: currentColor;
  stroke-width: 1.2;
  stroke-linejoin: round;
}

.file-label {
  position: absolute;
  left: 50%;
  bottom: 2px;
  max-width: 12px;
  transform: translateX(-50%);
  color: currentColor;
  font-size: 5.5px;
  font-weight: 800;
  line-height: 1;
  letter-spacing: -0.04em;
  text-align: center;
}
</style>
