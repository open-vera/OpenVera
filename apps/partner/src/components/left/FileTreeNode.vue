<script setup lang="ts">
import { ref } from "vue";
import { listDir, readFile } from "@/bridge";
import { isCodeFilePath, usePreviewStore } from "@/stores/preview";
import type { DirEntry } from "@/types";
import FileIcon from "./FileIcon.vue";
import FileTreeNode from "./FileTreeNode.vue";
import type { TreeEntry } from "./file-tree-types";

const props = defineProps<{
  entry: TreeEntry;
  depth?: number;
  selectedPath?: string | null;
}>();

const depth = props.depth ?? 0;
const expanded = ref(false);
const children = ref<TreeEntry[]>([]);
const loading = ref(false);
const preview = usePreviewStore();

function joinPath(parent: string, name: string): string {
  return `${parent.replace(/\/$/, "")}/${name}`;
}

function toTreeEntries(parent: string, items: DirEntry[]): TreeEntry[] {
  return items.map((item) => ({
    ...item,
    path: joinPath(parent, item.name),
  }));
}

async function onClick() {
  if (props.entry.isDir) {
    if (!expanded.value && children.value.length === 0) {
      loading.value = true;
      try {
        const items = await listDir(props.entry.path);
        children.value = toTreeEntries(props.entry.path, items);
      } catch (error) {
        console.warn("[FileTree] failed to list directory:", error);
      } finally {
        loading.value = false;
      }
    }
    expanded.value = !expanded.value;
    return;
  }

  if (!isCodeFilePath(props.entry.path)) return;
  try {
    const content = await readFile(props.entry.path);
    preview.openCodeFile(props.entry.path, content);
  } catch (error) {
    console.warn("[FileTree] failed to open file:", error);
  }
}
</script>

<template>
  <li class="tree-node">
    <button
      type="button"
      class="row"
      :class="{
        active: !entry.isDir && entry.path === selectedPath,
        folder: entry.isDir,
        expanded,
      }"
      :style="{ paddingLeft: `${depth * 12 + 4}px` }"
      :aria-expanded="entry.isDir ? expanded : undefined"
      @click="onClick"
    >
      <span v-if="entry.isDir" class="chevron" :class="{ expanded }" aria-hidden="true">
        <svg viewBox="0 0 20 20">
          <path d="M5 8l5 5 5-5" />
        </svg>
      </span>
      <FileIcon v-if="!entry.isDir" :path="entry.path" />
      <span class="name">{{ entry.name }}</span>
      <span v-if="loading" class="loading">…</span>
    </button>
    <ul
      v-if="entry.isDir && expanded"
      class="children"
      :style="{ '--guide-left': `${depth * 12 + 18}px` }"
    >
      <FileTreeNode
        v-for="child in children"
        :key="child.path"
        :entry="child"
        :depth="depth + 1"
        :selected-path="selectedPath"
      />
    </ul>
  </li>
</template>

<style scoped>
.tree-node {
  list-style: none;
  position: relative;
}

.row {
  display: flex;
  align-items: center;
  gap: 4px;
  width: 100%;
  min-height: 24px;
  padding-top: 0;
  padding-right: 8px;
  padding-bottom: 0;
  border: none;
  border-radius: 0;
  background: transparent;
  color: inherit;
  font-size: 13px;
  line-height: 24px;
  text-align: left;
  cursor: pointer;
}

.row:hover {
  background: var(--surface-hover);
}

.row.active {
  background: color-mix(in srgb, var(--accent) 22%, transparent);
  color: var(--text);
  outline: 1px solid color-mix(in srgb, var(--accent) 50%, transparent);
  outline-offset: -1px;
}

.row.active .name {
  font-weight: 500;
}

.chevron {
  width: 18px;
  height: 24px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  color: var(--text-muted);
}

.chevron svg {
  width: 14px;
  height: 14px;
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
  transform: rotate(-90deg);
  transition: transform 120ms ease;
}

.chevron.expanded svg {
  transform: rotate(0deg);
}

.name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.loading {
  margin-left: auto;
  color: var(--text-muted);
}

.children {
  position: relative;
  list-style: none;
  margin: 0;
  padding: 0;
}

.children::before {
  content: "";
  position: absolute;
  top: 0;
  bottom: 0;
  left: var(--guide-left);
  width: 1px;
  background: color-mix(in srgb, var(--border) 70%, transparent);
  pointer-events: none;
}
</style>
