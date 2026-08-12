<script setup lang="ts">
import { deliverComposerPathDrop } from "@/utils/composer-drop";
import { isPointOverChatDropZone } from "@/utils/partner-dnd";
import { startPointerTabDrag } from "@/utils/tab-dnd";

const props = defineProps<{
  tabId: string;
  title: string;
  filePath?: string | null;
  active?: boolean;
  dirty?: boolean;
  dropBefore?: boolean;
  dropAfter?: boolean;
}>();

const emit = defineEmits<{
  select: [];
  close: [];
  reorder: [insertionIndex: number];
  previewDrop: [insertionIndex: number | null];
}>();

/**
 * One pointer gesture, two outcomes: released over the tab strip reorders,
 * released over the composer drops the file path into it. HTML5 drag is not used
 * here — see `tab-dnd.ts` for why it cannot work on these elements.
 */
function onPointerDown(event: PointerEvent) {
  // Let the close affordance keep its own click.
  if ((event.target as HTMLElement | null)?.closest(".close")) return;
  startPointerTabDrag("preview", props.tabId, event, {
    onPreview: (index) => emit("previewDrop", index),
    onCommit: (index) => emit("reorder", index),
    onDropOutside: (clientX, clientY) => {
      if (!props.filePath) return;
      if (!isPointOverChatDropZone(clientX, clientY)) return;
      deliverComposerPathDrop([props.filePath]);
    },
  });
}
</script>

<template>
  <button
    type="button"
    class="tab"
    :class="{ active, 'drop-before': dropBefore, 'drop-after': dropAfter }"
    :data-tab-id="tabId"
    @click="emit('select')"
    @pointerdown="onPointerDown"
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
  gap: 6px;
  flex: 0 0 auto;
  min-width: max-content;
  height: 36px;
  padding: 0 10px;
  border: none;
  border-radius: 0;
  background: transparent;
  color: var(--text-muted);
  font-size: 12px;
  font-weight: 500;
  text-align: left;
  cursor: pointer;
}

.tab[draggable="true"] {
  cursor: grab;
}

.tab[draggable="true"]:active {
  cursor: grabbing;
}

/* Insertion marker while dragging. Inset shadow keeps ::before (hover) and
   ::after (active indicator) free. */
.tab.drop-before {
  box-shadow: inset 2px 0 0 var(--accent);
}

.tab.drop-after {
  box-shadow: inset -2px 0 0 var(--accent);
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
  width: 6px;
  height: 6px;
  flex-shrink: 0;
  border-radius: 999px;
  background: var(--accent);
}

.close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  flex-shrink: 0;
  border-radius: 5px;
  font-size: 15px;
  line-height: 1;
  opacity: 0;
  pointer-events: none;
}

.tab:hover .close,
.tab.active .close {
  opacity: 0.7;
  pointer-events: auto;
}

.tab:hover .close:hover,
.tab.active .close:hover {
  background: var(--surface-hover);
  opacity: 1;
}
</style>
