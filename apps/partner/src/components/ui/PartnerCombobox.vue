<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import ChevronIcon from "@/components/ui/ChevronIcon.vue";
import type { PartnerSelectOption } from "@/components/ui/PartnerSelect.vue";
import {
  positionAnchoredMenu,
  type AnchoredMenuPosition,
} from "@/utils/position-anchored-menu";

const props = withDefaults(
  defineProps<{
    modelValue: string;
    options?: PartnerSelectOption[];
    ariaLabel?: string;
    placeholder?: string;
    disabled?: boolean;
    /** Shown when the menu is open but no options match. */
    emptyLabel?: string;
  }>(),
  {
    options: () => [],
    ariaLabel: "Combobox",
    placeholder: "",
    disabled: false,
    emptyLabel: "No matches",
  },
);

const emit = defineEmits<{
  "update:modelValue": [value: string];
  change: [value: string];
  open: [];
}>();

const open = ref(false);
const root = ref<HTMLElement | null>(null);
const fieldRef = ref<HTMLElement | null>(null);
const menuRef = ref<HTMLElement | null>(null);
const inputRef = ref<HTMLInputElement | null>(null);
const menuStyle = ref<AnchoredMenuPosition | Record<string, never>>({});
/** Filter query while typing with the menu open; null means use modelValue. */
const filterQuery = ref<string | null>(null);

const query = computed(() =>
  (filterQuery.value ?? props.modelValue).trim().toLowerCase(),
);

const filteredOptions = computed(() => {
  const q = query.value;
  if (!q) return props.options;
  return props.options.filter((option) => {
    const haystack = `${option.value} ${option.label}`.toLowerCase();
    return haystack.includes(q);
  });
});

function repositionMenu() {
  if (!open.value) return;
  const rect = fieldRef.value?.getBoundingClientRect() ?? null;
  menuStyle.value = positionAnchoredMenu(rect, window, {
    width: Math.max(160, Math.round(rect?.width ?? 240)),
    preferredMaxHeight: 240,
    minHeight: 96,
    gap: 4,
    preferAbove: false,
    zIndex: 320,
  });
}

function setValue(value: string, commit = false) {
  emit("update:modelValue", value);
  if (commit) emit("change", value);
}

function onInput(event: Event) {
  const value = (event.target as HTMLInputElement).value;
  filterQuery.value = value;
  setValue(value);
  if (!open.value && props.options.length) {
    open.value = true;
    emit("open");
  }
}

function onFocus() {
  filterQuery.value = props.modelValue;
  if (props.options.length) {
    open.value = true;
    emit("open");
  }
}

function onBlur() {
  // Defer so option click can run first.
  window.setTimeout(() => {
    if (
      !root.value?.contains(document.activeElement) &&
      !menuRef.value?.contains(document.activeElement)
    ) {
      open.value = false;
      filterQuery.value = null;
      emit("change", props.modelValue);
    }
  }, 0);
}

async function toggleMenu() {
  if (props.disabled) return;
  if (open.value) {
    open.value = false;
    filterQuery.value = null;
    return;
  }
  filterQuery.value = props.modelValue;
  open.value = true;
  emit("open");
  inputRef.value?.focus();
  await nextTick();
  repositionMenu();
}

function selectOption(option: PartnerSelectOption) {
  if (option.disabled) return;
  setValue(option.value, true);
  filterQuery.value = null;
  open.value = false;
  inputRef.value?.focus();
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === "Escape") {
    open.value = false;
    filterQuery.value = null;
    return;
  }
  if (event.key === "ArrowDown" && !open.value && props.options.length) {
    event.preventDefault();
    open.value = true;
    emit("open");
  }
  if (event.key === "Enter" && open.value && filteredOptions.value.length === 1) {
    const only = filteredOptions.value[0];
    if (only && !only.disabled) {
      event.preventDefault();
      selectOption(only);
    }
  }
}

function onDocumentPointerDown(event: PointerEvent) {
  if (!open.value) return;
  const target = event.target;
  if (!(target instanceof Node)) return;
  if (root.value?.contains(target) || menuRef.value?.contains(target)) return;
  open.value = false;
  filterQuery.value = null;
}

function onViewportChange() {
  if (open.value) repositionMenu();
}

watch(
  () => props.modelValue,
  () => {
    if (!open.value) filterQuery.value = null;
  },
);

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
    class="partner-combobox"
    :class="{ open, disabled }"
    @keydown="onKeydown"
  >
    <div ref="fieldRef" class="partner-combobox-field">
      <input
        ref="inputRef"
        class="partner-combobox-input"
        type="text"
        :value="modelValue"
        :placeholder="placeholder"
        :aria-label="ariaLabel"
        :disabled="disabled"
        :aria-expanded="open"
        aria-autocomplete="list"
        role="combobox"
        autocomplete="off"
        spellcheck="false"
        @input="onInput"
        @focus="onFocus"
        @blur="onBlur"
      />
      <button
        type="button"
        class="partner-combobox-chevron"
        tabindex="-1"
        :aria-label="ariaLabel"
        :disabled="disabled"
        @mousedown.prevent="toggleMenu"
      >
        <ChevronIcon expanded :flipped="open" />
      </button>
    </div>

    <Teleport to="body">
      <div
        v-if="open"
        ref="menuRef"
        class="partner-combobox-menu"
        role="listbox"
        :aria-label="ariaLabel"
        :style="menuStyle"
      >
        <button
          v-for="option in filteredOptions"
          :key="option.value"
          type="button"
          class="partner-combobox-option"
          role="option"
          :aria-selected="modelValue === option.value"
          :class="{ active: modelValue === option.value }"
          :disabled="option.disabled"
          @mousedown.prevent="selectOption(option)"
        >
          <span class="partner-combobox-label">{{ option.label }}</span>
        </button>
        <p v-if="!filteredOptions.length" class="partner-combobox-empty">
          {{ emptyLabel }}
        </p>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.partner-combobox {
  position: relative;
  width: 100%;
  min-width: 0;
}

.partner-combobox-field {
  display: flex;
  align-items: stretch;
  width: 100%;
  min-height: 34px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-solid, var(--bg));
  overflow: hidden;
}

.partner-combobox.open .partner-combobox-field {
  border-color: color-mix(in srgb, var(--accent) 70%, var(--border));
  outline: 1px solid color-mix(in srgb, var(--accent) 36%, transparent);
}

.partner-combobox-field:hover {
  border-color: color-mix(in srgb, var(--accent) 45%, var(--border));
}

.partner-combobox-input {
  flex: 1;
  min-width: 0;
  margin: 0;
  border: none;
  border-radius: 0;
  padding: 5px 8px 5px 10px;
  background: transparent;
  color: var(--text);
  font: inherit;
  font-size: 12px;
  outline: none;
}

.partner-combobox-chevron {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 28px;
  margin: 0;
  border: none;
  border-left: 1px solid color-mix(in srgb, var(--border) 70%, transparent);
  background: transparent;
  color: var(--text-muted);
  font-size: 12px;
  cursor: pointer;
}

.partner-combobox-chevron:hover:not(:disabled) {
  color: var(--text);
  background: var(--surface-hover-solid, var(--surface-hover));
}

.partner-combobox.disabled {
  opacity: 0.55;
}

.partner-combobox.disabled .partner-combobox-chevron {
  cursor: not-allowed;
}

.partner-combobox-menu {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 2px;
  overflow: auto;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 4px;
  background: var(--surface-elevated-solid, var(--surface-elevated));
  box-shadow: 0 12px 28px color-mix(in srgb, #000 28%, transparent);
}

.partner-combobox-option {
  display: flex;
  align-items: center;
  width: 100%;
  min-height: 32px;
  margin: 0;
  border: 1px solid transparent;
  border-radius: 6px;
  padding: 5px 10px;
  background: transparent;
  color: var(--text);
  font: inherit;
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}

.partner-combobox-option:hover:not(:disabled) {
  border-color: color-mix(in srgb, var(--accent) 45%, var(--border));
  background: var(--surface-hover-solid, var(--surface-hover));
}

.partner-combobox-option.active {
  background: color-mix(
    in srgb,
    var(--accent) 14%,
    var(--surface-elevated-solid, var(--surface-elevated))
  );
}

.partner-combobox-option:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.partner-combobox-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.partner-combobox-empty {
  margin: 0;
  padding: 8px 10px;
  color: var(--text-muted);
  font-size: 11px;
}
</style>
