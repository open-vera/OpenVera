<script setup lang="ts">
import { computed, inject, onBeforeUnmount, onMounted, reactive } from "vue";
import { storeToRefs } from "pinia";
import { useFileClipboardStore } from "@/stores/file-clipboard";
import { useSettingsStore } from "@/stores/settings";
import { useWorkspaceStore } from "@/stores/workspace";
import { alertDialog } from "@/utils/native-dialog";
import {
  copyAbsolutePath,
  copyRelativePath,
  cutOrCopyEntries,
  deleteEntries,
  pasteClipboardInto,
  revealPathInOs,
} from "@/utils/file-ops";
import {
  FILE_TREE_INLINE_CREATE_KEY,
  FILE_TREE_INLINE_RENAME_KEY,
  FILE_TREE_REFRESH_KEY,
  type FileTreeContextTarget,
  type FileTreeInlineCreateMode,
} from "./file-tree-context";

const workspace = useWorkspaceStore();
const settings = useSettingsStore();
const clipboard = useFileClipboardStore();
const { hasEntries } = storeToRefs(clipboard);
const refreshTree = inject(FILE_TREE_REFRESH_KEY, async () => {});
const inlineRename = inject(FILE_TREE_INLINE_RENAME_KEY, null);
const inlineCreate = inject(FILE_TREE_INLINE_CREATE_KEY, null);

const menu = reactive({
  visible: false,
  x: 0,
  y: 0,
  target: null as FileTreeContextTarget | null,
});

const isZh = computed(() => settings.locale !== "en");
const labels = computed(() =>
  isZh.value
    ? {
        newFile: "新建文件…",
        newFolder: "新建文件夹…",
        reveal: "在 Finder 中显示",
        cut: "剪切",
        copy: "复制",
        copyPath: "复制路径",
        copyRelativePath: "复制相对路径",
        paste: "粘贴",
        rename: "重命名…",
        delete: "移到废纸篓",
      }
    : {
        newFile: "New File…",
        newFolder: "New Folder…",
        reveal: "Reveal in Finder",
        cut: "Cut",
        copy: "Copy",
        copyPath: "Copy Path",
        copyRelativePath: "Copy Relative Path",
        paste: "Paste",
        rename: "Rename…",
        delete: "Move to Trash",
      },
);

const canPaste = computed(() => hasEntries.value && Boolean(menu.target));
const isWorkspaceRoot = computed(() => {
  const target = menu.target;
  const root = workspace.rootPath.replace(/\/$/, "");
  return Boolean(target && root && target.path.replace(/\/$/, "") === root);
});
const canMutate = computed(() => Boolean(menu.target) && !isWorkspaceRoot.value);
const canCreate = computed(() => Boolean(menu.target?.isDir));

function hideMenu() {
  menu.visible = false;
  menu.target = null;
}

function showMenu(event: MouseEvent, target: FileTreeContextTarget) {
  event.preventDefault();
  event.stopPropagation();
  menu.visible = true;
  menu.target = target;
  menu.x = Math.min(event.clientX, window.innerWidth - 220);
  menu.y = Math.min(event.clientY, window.innerHeight - 320);
}

function beginInlineCreate(mode: FileTreeInlineCreateMode, target: FileTreeContextTarget) {
  if (!target.isDir) return;
  hideMenu();
  if (!inlineCreate) {
    console.warn("[FileTree] inline create API missing");
    return;
  }
  requestAnimationFrame(() => {
    inlineCreate.begin(target, mode);
  });
}

/** Start create flow from toolbar (project root / folder header). */
function promptCreate(
  mode: FileTreeInlineCreateMode,
  target: FileTreeContextTarget,
  _anchor?: { x: number; y: number },
) {
  beginInlineCreate(mode, target);
}

async function withRefresh(
  action: () => Promise<string | void>,
  options?: { reloadDir?: string },
) {
  try {
    const revealPath = await action();
    await refreshTree({
      ...(typeof revealPath === "string" && revealPath
        ? { revealPath }
        : {}),
      ...(options?.reloadDir ? { reloadDir: options.reloadDir } : {}),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await alertDialog(message, { kind: "error" });
  }
}

function onReveal() {
  const target = menu.target;
  hideMenu();
  if (!target) return;
  void withRefresh(async () => {
    await revealPathInOs(target.path);
  });
}

function onCut() {
  const target = menu.target;
  hideMenu();
  if (!target) return;
  cutOrCopyEntries("cut", [target]);
}

function onCopy() {
  const target = menu.target;
  hideMenu();
  if (!target) return;
  cutOrCopyEntries("copy", [target]);
}

function onCopyPath() {
  const target = menu.target;
  hideMenu();
  if (!target) return;
  void copyAbsolutePath(target.path);
}

function onCopyRelativePath() {
  const target = menu.target;
  hideMenu();
  if (!target || !workspace.rootPath) return;
  void copyRelativePath(workspace.rootPath, target.path);
}

function onPaste() {
  const target = menu.target;
  hideMenu();
  if (!target) return;
  const dir = target.isDir ? target.path : target.path.replace(/\/[^/]+$/, "");
  void withRefresh(async () => {
    await pasteClipboardInto(dir);
  }, { reloadDir: dir });
}

function onNewFile() {
  const target = menu.target;
  if (!target) return;
  beginInlineCreate("new-file", target);
}

function onNewFolder() {
  const target = menu.target;
  if (!target) return;
  beginInlineCreate("new-folder", target);
}

function onRename() {
  const target = menu.target;
  if (!target) {
    hideMenu();
    return;
  }
  hideMenu();
  if (!inlineRename) {
    console.warn("[FileTree] inline rename API missing; cannot rename in place");
    return;
  }
  requestAnimationFrame(() => {
    inlineRename.begin(target);
  });
}

function onDelete() {
  const target = menu.target;
  hideMenu();
  if (!target) return;
  const parent = target.path.replace(/\/[^/]+$/, "") || target.path;
  void withRefresh(async () => {
    await deleteEntries([target]);
  }, { reloadDir: parent });
}

function onGlobalPointerDown(event: PointerEvent) {
  if (!menu.visible) return;
  const el = event.target;
  if (el instanceof Element && el.closest("[data-file-tree-menu]")) return;
  hideMenu();
}

function onGlobalKeydown(event: KeyboardEvent) {
  if (event.key === "Escape" && menu.visible) {
    hideMenu();
  }
}

onMounted(() => {
  window.addEventListener("pointerdown", onGlobalPointerDown, true);
  window.addEventListener("keydown", onGlobalKeydown, true);
});

onBeforeUnmount(() => {
  window.removeEventListener("pointerdown", onGlobalPointerDown, true);
  window.removeEventListener("keydown", onGlobalKeydown, true);
});

defineExpose({ showMenu, hideMenu, promptCreate });
</script>

<template>
  <Teleport to="body">
    <div
      v-if="menu.visible && menu.target"
      class="file-tree-menu"
      data-file-tree-menu
      :style="{ left: `${menu.x}px`, top: `${menu.y}px` }"
      @click.stop
      @contextmenu.prevent
      @mousedown.stop
    >
      <template v-if="canCreate">
        <button type="button" @click="onNewFile">{{ labels.newFile }}</button>
        <button type="button" @click="onNewFolder">{{ labels.newFolder }}</button>
        <div class="menu-sep" />
      </template>
      <button type="button" @click="onReveal">{{ labels.reveal }}</button>
      <div class="menu-sep" />
      <button v-if="canMutate" type="button" @click="onCut">{{ labels.cut }}</button>
      <button v-if="canMutate" type="button" @click="onCopy">{{ labels.copy }}</button>
      <button type="button" @click="onCopyPath">{{ labels.copyPath }}</button>
      <button type="button" @click="onCopyRelativePath">{{ labels.copyRelativePath }}</button>
      <button v-if="canPaste" type="button" @click="onPaste">{{ labels.paste }}</button>
      <template v-if="canMutate">
        <div class="menu-sep" />
        <button type="button" @click="onRename">{{ labels.rename }}</button>
        <button type="button" class="danger" @click="onDelete">{{ labels.delete }}</button>
      </template>
    </div>
  </Teleport>
</template>

<style scoped>
.file-tree-menu {
  position: fixed;
  z-index: 1300;
  min-width: 200px;
  padding: 4px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface-elevated-solid, var(--surface-solid, var(--surface)));
  box-shadow: 0 10px 28px rgb(0 0 0 / 36%);
}

.file-tree-menu button {
  display: block;
  width: 100%;
  border: 0;
  border-radius: 5px;
  padding: 7px 10px;
  background: transparent;
  color: var(--text);
  font: inherit;
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}

.file-tree-menu button:hover {
  background: var(--surface-hover);
}

.file-tree-menu button.danger:hover {
  color: var(--danger-muted, #f87171);
}

.menu-sep {
  height: 1px;
  margin: 4px 6px;
  background: color-mix(in srgb, var(--border) 80%, transparent);
}
</style>
