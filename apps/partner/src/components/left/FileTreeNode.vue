<script setup lang="ts">
import {
  computed,
  inject,
  nextTick,
  onBeforeUnmount,
  ref,
  watch,
} from "vue";
import { listDir } from "@/bridge";
import ChevronIcon from "@/components/ui/ChevronIcon.vue";
import { measureAsync, measureSync, recordPerfEvent } from "@/perf";
import { openWorkspaceFile } from "@/utils/open-workspace-file";
import { isAncestorDir } from "@/utils/file-tree-reveal";
import type { DirEntry } from "@/types";
import FileIcon from "./FileIcon.vue";
import FileTreeNode from "./FileTreeNode.vue";
import type { TreeEntry } from "./file-tree-types";
import FileTreeInlineCreateRow from "./FileTreeInlineCreateRow.vue";
import { deliverComposerPathDrop } from "@/utils/composer-drop";
import {
  clearActivePartnerDrag,
  finishPartnerPathsDragAt,
  setPartnerPathsDrag,
} from "@/utils/partner-dnd";
import {
  FILE_TREE_INLINE_CREATE_KEY,
  FILE_TREE_INLINE_RENAME_KEY,
  FILE_TREE_SCROLL_ROOT_KEY,
  normalizeFsPath,
  type FileTreeContextTarget,
  type FileTreeDirReloadRequest,
} from "./file-tree-context";

const props = defineProps<{
  entry: TreeEntry;
  depth?: number;
  selectedPath?: string | null;
  /** When set, ancestor folders of this path auto-expand to reveal the file. */
  revealPath?: string | null;
  /** Bumped on full tree refresh — expanded dirs re-list. */
  treeEpoch?: number;
  /** Targeted reload for a single directory after create/delete/etc. */
  dirReload?: FileTreeDirReloadRequest | null;
}>();

const CHILD_PAGE_SIZE = 48;
const SOFT_REFRESH_MS = 20_000;

const depth = props.depth ?? 0;
const expanded = ref(false);
const children = ref<TreeEntry[]>([]);
const visibleLimit = ref(CHILD_PAGE_SIZE);
const loading = ref(false);
const lazySentinelRef = ref<HTMLElement | null>(null);
const renameInputRef = ref<HTMLInputElement | null>(null);
const renameDraft = ref("");
let renameCommitted = false;
let childrenReload: Promise<void> | null = null;
let childrenLoadedAt = 0;
let lazyObserver: IntersectionObserver | null = null;
/** Prevent cascade loads while the sentinel stays intersecting after a page bump. */
let lazyArmed = true;
/** Some webviews still emit a primary `click` after `contextmenu`; ignore it. */
let suppressClickUntil = 0;

const visibleChildren = computed(() => children.value.slice(0, visibleLimit.value));
const hasMoreChildren = computed(() => children.value.length > visibleLimit.value);

const showContextMenu = inject<
  ((event: MouseEvent, target: FileTreeContextTarget) => void) | null
>("fileTreeShowContextMenu", null);
const inlineRename = inject(FILE_TREE_INLINE_RENAME_KEY, null);
const inlineCreate = inject(FILE_TREE_INLINE_CREATE_KEY, null);
const scrollRootRef = inject(FILE_TREE_SCROLL_ROOT_KEY, null);

const isRenaming = computed(
  () => inlineRename?.session.value?.path === props.entry.path,
);
const isCreatingHere = computed(() => {
  const session = inlineCreate?.session.value;
  if (!session || !props.entry.isDir) return false;
  return normalizeFsPath(session.parentPath) === normalizeFsPath(props.entry.path);
});
const createMode = computed(() => inlineCreate?.session.value?.mode ?? "new-file");

function joinPath(parent: string, name: string): string {
  return `${parent.replace(/\/$/, "")}/${name}`;
}

function toTreeEntries(parent: string, items: DirEntry[]): TreeEntry[] {
  return items.map((item) => ({
    ...item,
    path: joinPath(parent, item.name),
  }));
}

function logFileTreePerf(
  phase: string,
  durationMs: number,
  meta: Record<string, string | number | boolean | null>,
): void {
  const detail = Object.entries(meta)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(" ");
  console.info(`[FileTreePerf] ${phase} ${durationMs}ms ${detail}`);
  if (durationMs < 16) return;
  recordPerfEvent({
    kind: "slow_op",
    severity: durationMs >= 100 ? "error" : "warn",
    durationMs,
    name: `fileTree.${phase}`,
    detail: `${phase} ${durationMs}ms ${detail}`,
    meta,
  });
}

async function reloadChildren(): Promise<void> {
  if (!props.entry.isDir) return;
  if (childrenReload) {
    await childrenReload;
    return;
  }
  const run = (async () => {
    loading.value = true;
    const started = performance.now();
    try {
      const items = await measureAsync(
        "fileTree.listDir",
        () => listDir(props.entry.path),
        {
          warnMs: 16,
          errorMs: 80,
          recordOnlySlow: false,
          meta: { path: props.entry.path },
        },
      );
      const listMs = Math.round(performance.now() - started);
      const assignStarted = performance.now();
      children.value = measureSync(
        "fileTree.mapEntries",
        () => toTreeEntries(props.entry.path, items),
        {
          warnMs: 8,
          errorMs: 40,
          recordOnlySlow: false,
          meta: { path: props.entry.path, count: items.length },
        },
      );
      childrenLoadedAt = Date.now();
      if (visibleLimit.value < CHILD_PAGE_SIZE) {
        visibleLimit.value = CHILD_PAGE_SIZE;
      }
      await nextTick();
      const renderMs = Math.round(performance.now() - assignStarted);
      logFileTreePerf("reloadChildren", Math.round(performance.now() - started), {
        path: props.entry.path,
        listMs,
        renderMs,
        childCount: items.length,
        visible: visibleLimit.value,
      });
    } catch (error) {
      console.warn("[FileTree] failed to list directory:", error);
    } finally {
      loading.value = false;
    }
  })();
  childrenReload = run;
  try {
    await run;
  } finally {
    if (childrenReload === run) childrenReload = null;
  }
}

function loadMoreChildren() {
  if (!hasMoreChildren.value || !lazyArmed) return;
  lazyArmed = false;
  const before = visibleLimit.value;
  visibleLimit.value = Math.min(
    children.value.length,
    visibleLimit.value + CHILD_PAGE_SIZE,
  );
  logFileTreePerf("loadMore", 0, {
    path: props.entry.path,
    before,
    after: visibleLimit.value,
    childCount: children.value.length,
  });
}

function disconnectLazyObserver() {
  lazyObserver?.disconnect();
  lazyObserver = null;
}

function bindLazyObserver() {
  disconnectLazyObserver();
  const sentinel = lazySentinelRef.value;
  const root = scrollRootRef?.value ?? null;
  // Without a scroll root, viewport-based IO would treat clipped rows as visible
  // and cascade-load the entire directory.
  if (!sentinel || !hasMoreChildren.value || !root) return;

  lazyObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) {
          lazyArmed = true;
          continue;
        }
        if (lazyArmed) {
          loadMoreChildren();
        }
      }
    },
    {
      root,
      rootMargin: "80px 0px",
      threshold: 0,
    },
  );
  lazyObserver.observe(sentinel);
}

async function ensureChildrenLoaded(): Promise<void> {
  if (!props.entry.isDir) return;
  if (childrenReload) {
    await childrenReload;
    return;
  }
  if (children.value.length > 0) return;
  await reloadChildren();
}

async function expandForReveal(): Promise<void> {
  if (!props.entry.isDir || !props.revealPath) return;
  if (!isAncestorDir(props.entry.path, props.revealPath)) return;
  await reloadChildren();
  const reveal = normalizeFsPath(props.revealPath);
  const index = children.value.findIndex(
    (child) =>
      normalizeFsPath(child.path) === reveal ||
      isAncestorDir(child.path, props.revealPath!),
  );
  if (index >= 0) {
    visibleLimit.value = Math.max(visibleLimit.value, index + 1);
  }
  expanded.value = true;
}

async function onClick(event?: MouseEvent) {
  // Right-click / other buttons should only open the context menu.
  if (event && event.button !== 0) return;
  if (Date.now() < suppressClickUntil) return;
  if (isRenaming.value) return;
  if (props.entry.isDir) {
    if (expanded.value) {
      expanded.value = false;
      return;
    }
    const started = performance.now();
    // Expand immediately so the chevron responds; load/refresh afterwards.
    expanded.value = true;
    visibleLimit.value = CHILD_PAGE_SIZE;
    lazyArmed = true;
    await nextTick();
    const uiMs = Math.round(performance.now() - started);
    logFileTreePerf("expandUI", uiMs, {
      path: props.entry.path,
      cached: children.value.length > 0,
    });
    if (children.value.length === 0) {
      await reloadChildren();
      logFileTreePerf("expandTotal", Math.round(performance.now() - started), {
        path: props.entry.path,
        childCount: children.value.length,
        visible: visibleLimit.value,
      });
      return;
    }
    const stale = Date.now() - childrenLoadedAt > SOFT_REFRESH_MS;
    if (stale && children.value.length <= CHILD_PAGE_SIZE) {
      void reloadChildren();
    }
    return;
  }

  await measureAsync(
    "fileTree.openFile",
    () => openWorkspaceFile(props.entry.path),
    {
      warnMs: 16,
      errorMs: 120,
      recordOnlySlow: false,
      meta: { path: props.entry.path },
    },
  );
}

function onRowKeydown(event: KeyboardEvent) {
  if (isRenaming.value) return;
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    void onClick();
  }
}

function onContextMenu(event: MouseEvent) {
  event.preventDefault();
  event.stopPropagation();
  // Swallow a follow-up click that some platforms fire after contextmenu.
  suppressClickUntil = Date.now() + 400;
  showContextMenu?.(event, {
    path: props.entry.path,
    name: props.entry.name,
    isDir: props.entry.isDir,
  });
}

function onDragStart(event: DragEvent) {
  if (isRenaming.value || !event.dataTransfer) return;
  setPartnerPathsDrag(event.dataTransfer, [
    { path: props.entry.path, isDir: props.entry.isDir },
  ]);
}

function onDragEnd(event: DragEvent) {
  const items = finishPartnerPathsDragAt(event.clientX, event.clientY);
  if (items?.length) {
    deliverComposerPathDrop(items.map((item) => item.path));
    return;
  }
  clearActivePartnerDrag();
}

function focusRenameInput(name: string) {
  const input = renameInputRef.value;
  if (!input) return;
  input.focus();
  const dot = name.lastIndexOf(".");
  if (dot > 0) {
    input.setSelectionRange(0, dot);
  } else {
    input.select();
  }
}

async function commitRename() {
  if (!isRenaming.value || !inlineRename || renameCommitted) return;
  renameCommitted = true;
  await inlineRename.commit(renameDraft.value);
}

function cancelRename() {
  if (!inlineRename || renameCommitted) return;
  renameCommitted = true;
  inlineRename.cancel();
}

watch(
  isRenaming,
  async (renaming) => {
    if (!renaming) {
      renameCommitted = false;
      return;
    }
    renameCommitted = false;
    renameDraft.value = props.entry.name;
    await nextTick();
    focusRenameInput(props.entry.name);
  },
);

watch(
  () => props.revealPath,
  () => {
    void expandForReveal();
  },
  { immediate: true },
);

watch(
  () => props.treeEpoch ?? 0,
  (epoch, prev) => {
    if (!props.entry.isDir || epoch === prev) return;
    if (expanded.value) {
      void reloadChildren();
      return;
    }
    children.value = [];
  },
);

watch(
  () => props.dirReload,
  (request) => {
    if (!request || !props.entry.isDir) return;
    if (normalizeFsPath(request.path) !== normalizeFsPath(props.entry.path)) {
      return;
    }
    expanded.value = true;
    void reloadChildren();
  },
);

watch(
  isCreatingHere,
  async (creating) => {
    if (!creating || !props.entry.isDir) return;
    expanded.value = true;
    await ensureChildrenLoaded();
  },
  { immediate: true },
);

watch(
  [expanded, hasMoreChildren, visibleLimit, () => children.value.length],
  async () => {
    if (!expanded.value || !hasMoreChildren.value) {
      disconnectLazyObserver();
      return;
    }
    await nextTick();
    bindLazyObserver();
  },
);

onBeforeUnmount(() => {
  disconnectLazyObserver();
});

async function commitCreate(name: string) {
  await inlineCreate?.commit(name);
}

function cancelCreate() {
  inlineCreate?.cancel();
}
</script>

<template>
  <li class="tree-node">
    <div
      class="row"
      :class="{
        active: !entry.isDir && entry.path === selectedPath,
        folder: entry.isDir,
        expanded,
        renaming: isRenaming,
      }"
      :style="{ paddingLeft: `${depth * 12 + 4}px` }"
      :role="isRenaming ? undefined : 'button'"
      :tabindex="isRenaming ? -1 : 0"
      :aria-expanded="entry.isDir ? expanded : undefined"
      :draggable="!isRenaming"
      @click.left="onClick"
      @keydown="onRowKeydown"
      @contextmenu="onContextMenu"
      @dragstart="onDragStart"
      @dragend="onDragEnd"
    >
      <span v-if="entry.isDir" class="chevron" aria-hidden="true">
        <ChevronIcon :expanded="expanded" />
      </span>
      <FileIcon v-if="!entry.isDir" :path="entry.path" />
      <input
        v-if="isRenaming"
        ref="renameInputRef"
        v-model="renameDraft"
        class="rename-input"
        type="text"
        spellcheck="false"
        aria-label="Rename"
        @click.stop
        @mousedown.stop
        @keydown.enter.prevent="commitRename"
        @keydown.esc.prevent="cancelRename"
        @blur="commitRename"
      />
      <span v-else class="name">{{ entry.name }}</span>
      <span v-if="loading" class="loading">…</span>
    </div>
    <ul
      v-if="entry.isDir && (expanded || isCreatingHere)"
      class="children"
      :style="{ '--guide-left': `${depth * 12 + 18}px` }"
    >
      <FileTreeInlineCreateRow
        v-if="isCreatingHere"
        :mode="createMode"
        :depth="depth + 1"
        @commit="commitCreate"
        @cancel="cancelCreate"
      />
      <FileTreeNode
        v-for="child in visibleChildren"
        :key="child.path"
        :entry="child"
        :depth="depth + 1"
        :selected-path="selectedPath"
        :reveal-path="revealPath"
        :tree-epoch="treeEpoch"
        :dir-reload="dirReload"
      />
      <li
        v-if="hasMoreChildren"
        ref="lazySentinelRef"
        class="lazy-sentinel"
        aria-hidden="true"
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
  box-sizing: border-box;
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

.row.renaming {
  background: transparent;
  outline: none;
  cursor: default;
}

.row.renaming:hover {
  background: transparent;
}

.chevron {
  width: 18px;
  height: 24px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  color: var(--text-muted);
  font-size: 14px;
}

.name,
.rename-input {
  min-width: 0;
  flex: 1;
  font: inherit;
  font-size: 13px;
  line-height: 22px;
  color: inherit;
}

.name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.rename-input {
  height: 22px;
  margin: 0;
  padding: 0 2px;
  border: 1px solid var(--accent, #6aa8ff);
  border-radius: 2px;
  background: var(--bg, #1e1e1e);
  outline: none;
  box-shadow: none;
}

.lazy-sentinel {
  list-style: none;
  height: 1px;
  margin: 0;
  padding: 0;
  pointer-events: none;
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
