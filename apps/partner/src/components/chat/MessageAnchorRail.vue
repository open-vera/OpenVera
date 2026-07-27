<script setup lang="ts">
import { computed, ref } from "vue";
import type { MessageAnchor } from "@/utils/message-anchors";

const props = defineProps<{
  anchors: MessageAnchor[];
}>();

const emit = defineEmits<{
  select: [messageId: string];
}>();

const hoveredId = ref<string | null>(null);
const tooltipStyle = ref<Record<string, string>>({});

const hoveredPreview = computed(
  () => props.anchors.find((anchor) => anchor.id === hoveredId.value)?.preview ?? "",
);

function showPreview(anchor: MessageAnchor, event: MouseEvent | FocusEvent) {
  const target = event.currentTarget;
  if (!(target instanceof HTMLElement)) return;
  hoveredId.value = anchor.id;
  const rect = target.getBoundingClientRect();
  const top = Math.min(
    Math.max(12, rect.top + rect.height / 2),
    window.innerHeight - 12,
  );
  const left = Math.min(rect.right + 10, window.innerWidth - 24);
  tooltipStyle.value = {
    top: `${top}px`,
    left: `${left}px`,
  };
}

function hidePreview() {
  hoveredId.value = null;
}

function onSelect(id: string) {
  hidePreview();
  emit("select", id);
}
</script>

<template>
  <nav
    v-if="anchors.length"
    class="message-anchor-rail"
    aria-label="用户发言锚点"
  >
    <button
      v-for="anchor in anchors"
      :key="anchor.id"
      type="button"
      class="anchor-tick"
      :class="{ hovered: hoveredId === anchor.id }"
      :aria-label="anchor.preview"
      @mouseenter="showPreview(anchor, $event)"
      @mousemove="showPreview(anchor, $event)"
      @mouseleave="hidePreview"
      @focus="showPreview(anchor, $event)"
      @blur="hidePreview"
      @click="onSelect(anchor.id)"
    />
  </nav>

  <Teleport to="body">
    <div
      v-if="hoveredId && hoveredPreview"
      class="anchor-preview-card"
      :style="tooltipStyle"
      role="tooltip"
    >
      {{ hoveredPreview }}
    </div>
  </Teleport>
</template>

<style scoped>
.message-anchor-rail {
  position: absolute;
  top: 50%;
  left: 4px;
  z-index: 3;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 5px;
  width: 18px;
  max-height: calc(100% - 24px);
  padding: 4px 0;
  overflow: visible;
  pointer-events: none;
  transform: translateY(-50%);
}

.anchor-tick {
  position: relative;
  pointer-events: auto;
  display: block;
  flex-shrink: 0;
  width: 16px;
  height: 12px;
  padding: 0;
  border: none;
  background: transparent;
  cursor: pointer;
}

.anchor-tick::before {
  content: "";
  position: absolute;
  top: 50%;
  left: 50%;
  width: 10px;
  height: 2px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--text-muted) 72%, transparent);
  transform: translate(-50%, -50%);
  transition:
    width 120ms ease,
    background 120ms ease;
}

.anchor-tick:hover::before,
.anchor-tick.hovered::before,
.anchor-tick:focus-visible::before {
  width: 14px;
  background: var(--text);
}
</style>

<style>
/* Teleported outside the panel — must not be scoped. */
.anchor-preview-card {
  position: fixed;
  z-index: 10050;
  max-width: min(320px, 48vw);
  max-height: 148px;
  padding: 10px 12px;
  border: 1px solid color-mix(in srgb, var(--border) 78%, transparent);
  border-radius: 10px;
  background: color-mix(
    in srgb,
    var(--surface-elevated-solid, var(--surface-elevated)) 94%,
    transparent
  );
  color: var(--text);
  font-size: 12px;
  line-height: 1.45;
  white-space: pre-wrap;
  overflow: hidden;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 6;
  line-clamp: 6;
  transform: translateY(-50%);
  box-shadow: 0 10px 28px color-mix(in srgb, #000 28%, transparent);
  pointer-events: none;
}
</style>
