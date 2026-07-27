<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import ChevronIcon from "@/components/ui/ChevronIcon.vue";
import {
  positionAnchoredMenu,
  type AnchoredMenuPosition,
} from "@/utils/position-anchored-menu";

export interface PartnerSelectOption {
  value: string;
  label: string;
  /** Optional 4-stop color scale shown beside the label */
  preview?: readonly [string, string, string, string];
  disabled?: boolean;
}

export interface PartnerSelectGroup {
  label: string;
  options: PartnerSelectOption[];
}

const props = withDefaults(
  defineProps<{
    modelValue: string;
    options?: PartnerSelectOption[];
    groups?: PartnerSelectGroup[];
    ariaLabel?: string;
    placeholder?: string;
    /** Override trigger label/preview when value isn't in the option list (e.g. custom theme). */
    displayOption?: PartnerSelectOption | null;
    /** Emphasize trigger when value is a special state (e.g. custom theme) */
    emphasized?: boolean;
    disabled?: boolean;
  }>(),
  {
    options: () => [],
    groups: () => [],
    ariaLabel: "Select",
    placeholder: "Select…",
    displayOption: null,
    emphasized: false,
    disabled: false,
  },
);

const emit = defineEmits<{
  "update:modelValue": [value: string];
}>();

const open = ref(false);
const root = ref<HTMLElement | null>(null);
const triggerRef = ref<HTMLButtonElement | null>(null);
const menuRef = ref<HTMLElement | null>(null);
const menuStyle = ref<AnchoredMenuPosition | Record<string, never>>({});

const flatOptions = computed(() => {
  if (props.groups.length > 0) {
    return props.groups.flatMap((group) => group.options);
  }
  return props.options;
});

const selected = computed(() => {
  if (props.displayOption) return props.displayOption;
  return flatOptions.value.find((option) => option.value === props.modelValue) ?? null;
});

const menuSections = computed(() => {
  if (props.groups.length > 0) return props.groups;
  return [{ label: "", options: props.options }];
});

function repositionMenu() {
  if (!open.value) return;
  const rect = triggerRef.value?.getBoundingClientRect() ?? null;
  menuStyle.value = positionAnchoredMenu(rect, window, {
    width: Math.max(160, Math.round(rect?.width ?? 240)),
    preferredMaxHeight: 280,
    minHeight: 96,
    gap: 4,
    preferAbove: false,
    zIndex: 320,
  });
}

async function toggle() {
  if (props.disabled) return;
  open.value = !open.value;
  if (open.value) {
    await nextTick();
    repositionMenu();
  }
}

function selectOption(option: PartnerSelectOption) {
  if (option.disabled) return;
  emit("update:modelValue", option.value);
  open.value = false;
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === "Escape") open.value = false;
}

function onDocumentPointerDown(event: PointerEvent) {
  if (!open.value) return;
  const target = event.target;
  if (!(target instanceof Node)) return;
  if (root.value?.contains(target) || menuRef.value?.contains(target)) return;
  open.value = false;
}

function onViewportChange() {
  if (open.value) repositionMenu();
}

watch(open, async (isOpen) => {
  if (!isOpen) {
    menuStyle.value = {};
    return;
  }
  await nextTick();
  repositionMenu();
});

onMounted(() => {
  document.addEventListener("pointerdown", onDocumentPointerDown);
  window.addEventListener("resize", onViewportChange);
  window.addEventListener("scroll", onViewportChange, true);
});

onBeforeUnmount(() => {
  document.removeEventListener("pointerdown", onDocumentPointerDown);
  window.removeEventListener("resize", onViewportChange);
  window.removeEventListener("scroll", onViewportChange, true);
});
</script>

<template>
  <div
    ref="root"
    class="partner-select"
    :class="{ open, emphasized, disabled }"
    @keydown="onKeydown"
  >
    <button
      ref="triggerRef"
      type="button"
      class="partner-select-trigger"
      :aria-expanded="open"
      aria-haspopup="listbox"
      :aria-label="ariaLabel"
      :disabled="disabled"
      @click="toggle"
    >
      <span
        v-if="selected?.preview"
        class="partner-select-scale"
        aria-hidden="true"
      >
        <i
          v-for="(color, index) in selected.preview"
          :key="`selected-${index}`"
          :style="{ background: color }"
        />
      </span>
      <span class="partner-select-label">
        {{ selected?.label ?? placeholder }}
      </span>
      <span class="partner-select-chevron" aria-hidden="true">
        <ChevronIcon expanded :flipped="open" />
      </span>
    </button>

    <Teleport to="body">
      <div
        v-if="open"
        ref="menuRef"
        class="partner-select-menu"
        role="listbox"
        :aria-label="ariaLabel"
        :style="menuStyle"
      >
        <template v-for="(section, sectionIndex) in menuSections" :key="sectionIndex">
          <div v-if="section.label" class="partner-select-group-label">
            {{ section.label }}
          </div>
          <button
            v-for="option in section.options"
            :key="option.value"
            type="button"
            class="partner-select-option"
            role="option"
            :aria-selected="modelValue === option.value"
            :class="{ active: modelValue === option.value }"
            :disabled="option.disabled"
            @click="selectOption(option)"
          >
            <span
              v-if="option.preview"
              class="partner-select-scale"
              aria-hidden="true"
            >
              <i
                v-for="(color, index) in option.preview"
                :key="`${option.value}-${index}`"
                :style="{ background: color }"
              />
            </span>
            <span class="partner-select-label">{{ option.label }}</span>
          </button>
        </template>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.partner-select {
  position: relative;
  width: 100%;
}

.partner-select-trigger,
.partner-select-option {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  min-height: 34px;
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 5px 10px;
  background: var(--bg-solid, var(--bg));
  color: var(--text);
  font: inherit;
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}

.partner-select-trigger:hover:not(:disabled) {
  border-color: color-mix(in srgb, var(--accent) 45%, var(--border));
  background: var(--surface-hover-solid, var(--surface-hover));
}

.partner-select.open .partner-select-trigger,
.partner-select.emphasized .partner-select-trigger {
  border-color: color-mix(in srgb, var(--accent) 70%, var(--border));
  outline: 1px solid color-mix(in srgb, var(--accent) 36%, transparent);
}

.partner-select.disabled .partner-select-trigger {
  opacity: 0.55;
  cursor: not-allowed;
}

.partner-select-chevron {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  margin-left: auto;
  color: var(--text-muted);
  font-size: 12px;
}

.partner-select-menu {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 2px;
  overflow: auto;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 4px;
  background: var(--surface-elevated-solid, var(--surface-elevated));
  -webkit-backdrop-filter: none;
  backdrop-filter: none;
  box-shadow: 0 12px 28px color-mix(in srgb, #000 28%, transparent);
}

.partner-select-group-label {
  margin: 4px 8px 2px;
  color: var(--text-muted);
  font-size: 10px;
  font-weight: 650;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.partner-select-option {
  border-color: transparent;
  background: transparent;
}

.partner-select-option:hover:not(:disabled) {
  border-color: color-mix(in srgb, var(--accent) 45%, var(--border));
  background: var(--surface-hover-solid, var(--surface-hover));
}

.partner-select-option.active {
  background: color-mix(
    in srgb,
    var(--accent) 14%,
    var(--surface-elevated-solid, var(--surface-elevated))
  );
}

.partner-select-option:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.partner-select-scale {
  display: grid;
  grid-template-columns: 1.3fr 1fr 0.85fr 0.7fr;
  flex: 0 0 86px;
  width: 86px;
  height: 16px;
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--border) 80%, transparent);
  border-radius: 999px;
}

.partner-select-scale i {
  display: block;
  height: 100%;
}

.partner-select-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
