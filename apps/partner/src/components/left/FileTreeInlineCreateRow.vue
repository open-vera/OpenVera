<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from "vue";
import FileIcon from "./FileIcon.vue";
import type { FileTreeInlineCreateMode } from "./file-tree-context";

const props = defineProps<{
  mode: FileTreeInlineCreateMode;
  depth?: number;
}>();

const emit = defineEmits<{
  commit: [name: string];
  cancel: [];
}>();

const draft = ref(props.mode === "new-file" ? "untitled.txt" : "untitled");
const inputRef = ref<HTMLInputElement | null>(null);
let settled = false;

const previewPath = computed(() =>
  props.mode === "new-folder" ? `${draft.value}/` : draft.value,
);

function focusInput() {
  const input = inputRef.value;
  if (!input) return;
  input.focus();
  const name = draft.value;
  const dot = name.lastIndexOf(".");
  if (props.mode === "new-file" && dot > 0) {
    input.setSelectionRange(0, dot);
  } else {
    input.select();
  }
}

function commit() {
  if (settled) return;
  settled = true;
  emit("commit", draft.value);
}

function cancel() {
  if (settled) return;
  settled = true;
  emit("cancel");
}

onMounted(async () => {
  await nextTick();
  focusInput();
});

watch(
  () => props.mode,
  async () => {
    settled = false;
    draft.value = props.mode === "new-file" ? "untitled.txt" : "untitled";
    await nextTick();
    focusInput();
  },
);
</script>

<template>
  <li class="inline-create" :style="{ paddingLeft: `${(depth ?? 0) * 12 + 4}px` }">
    <span v-if="mode === 'new-folder'" class="folder-spacer" aria-hidden="true" />
    <FileIcon v-else :path="previewPath" />
    <input
      ref="inputRef"
      v-model="draft"
      class="create-input"
      type="text"
      spellcheck="false"
      :aria-label="mode === 'new-folder' ? 'New folder name' : 'New file name'"
      @keydown.enter.prevent="commit"
      @keydown.esc.prevent="cancel"
      @blur="commit"
      @click.stop
      @mousedown.stop
    />
  </li>
</template>

<style scoped>
.inline-create {
  display: flex;
  align-items: center;
  gap: 4px;
  min-height: 24px;
  padding-right: 8px;
  list-style: none;
}

.folder-spacer {
  width: 18px;
  flex-shrink: 0;
}

.create-input {
  flex: 1;
  min-width: 0;
  height: 22px;
  margin: 0;
  padding: 0 2px;
  border: 1px solid var(--accent, #6aa8ff);
  border-radius: 2px;
  background: var(--bg, #1e1e1e);
  color: var(--text);
  font: inherit;
  font-size: 13px;
  line-height: 22px;
  outline: none;
  box-shadow: none;
}
</style>
