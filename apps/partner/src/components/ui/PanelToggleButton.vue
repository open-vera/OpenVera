<script setup lang="ts">
withDefaults(
  defineProps<{
    /** Which side bar is highlighted inside the icon */
    side?: "left" | "right";
    title?: string;
    /** Panel is currently visible */
    open?: boolean;
  }>(),
  {
    side: "left",
    open: true,
  },
);

defineEmits<{
  click: [];
}>();
</script>

<template>
  <button
    type="button"
    class="panel-toggle"
    :class="[`side-${side}`, { open }]"
    :aria-label="title"
    :aria-pressed="open"
    @click="$emit('click')"
  >
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <rect
        x="1.75"
        y="2.75"
        width="12.5"
        height="10.5"
        rx="1.5"
        fill="none"
        stroke="currentColor"
        stroke-width="1.25"
      />
      <rect
        v-if="side === 'left'"
        class="panel-bar"
        x="2.85"
        y="3.85"
        width="3.4"
        height="8.3"
        rx="0.6"
      />
      <rect
        v-else
        class="panel-bar"
        x="9.75"
        y="3.85"
        width="3.4"
        height="8.3"
        rx="0.6"
      />
    </svg>
    <span v-if="title" class="panel-tooltip" role="tooltip">{{ title }}</span>
  </button>
</template>

<style scoped>
.panel-toggle {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: none;
  border-radius: 5px;
  padding: 0;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
}

.panel-toggle:hover,
.panel-toggle.open {
  color: var(--text);
}

.panel-toggle:hover {
  background: var(--surface-hover);
}

.panel-toggle svg {
  width: 16px;
  height: 16px;
  display: block;
}

.panel-bar {
  fill: currentColor;
  opacity: 0.88;
}

.panel-toggle:not(.open) .panel-bar {
  opacity: 0.35;
}

.panel-tooltip {
  position: absolute;
  top: calc(100% + 6px);
  left: 50%;
  z-index: 40;
  padding: 4px 8px;
  border: 1px solid color-mix(in srgb, var(--border) 80%, transparent);
  border-radius: 6px;
  background: color-mix(in srgb, var(--surface-elevated) 94%, transparent);
  color: var(--text);
  font-size: 11px;
  font-weight: 500;
  line-height: 1.3;
  white-space: nowrap;
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.22);
  opacity: 0;
  pointer-events: none;
  transform: translate(-50%, -2px);
  transition: opacity 80ms ease, transform 80ms ease;
}

.panel-toggle:hover .panel-tooltip,
.panel-toggle:focus-visible .panel-tooltip {
  opacity: 1;
  transform: translate(-50%, 0);
}

.panel-toggle.side-left .panel-tooltip {
  left: 0;
  transform: translate(0, -2px);
}

.panel-toggle.side-left:hover .panel-tooltip,
.panel-toggle.side-left:focus-visible .panel-tooltip {
  transform: translate(0, 0);
}

.panel-toggle.side-right .panel-tooltip {
  left: auto;
  right: 0;
  transform: translate(0, -2px);
}

.panel-toggle.side-right:hover .panel-tooltip,
.panel-toggle.side-right:focus-visible .panel-tooltip {
  transform: translate(0, 0);
}
</style>
