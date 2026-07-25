<script setup lang="ts">
import { MergeView } from "@codemirror/merge";
import { search, searchKeymap } from "@codemirror/search";
import { EditorState } from "@codemirror/state";
import type { Extension } from "@codemirror/state";
import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { basicSetup } from "codemirror";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { parseUnifiedDiff } from "@/preview/diff";
import {
  detectLanguageFromPath,
  languageSupportFor,
  type PreviewLanguageId,
} from "@/preview/language";
import { partnerEditorHighlight, partnerEditorTheme } from "@/preview/theme";

const props = defineProps<{
  filePath: string;
  content: string;
}>();

const containerRef = ref<HTMLDivElement | null>(null);
let mergeView: MergeView | null = null;

const parsed = computed(() => parseUnifiedDiff(props.content, props.filePath.replace(/\.diff$/i, "")));
const language = computed<PreviewLanguageId>(() => detectLanguageFromPath(parsed.value.filePath));

function editorExtensions(languageId: PreviewLanguageId): Extension[] {
  const languageSupport = languageSupportFor(languageId);
  return [
    basicSetup,
    partnerEditorTheme,
    partnerEditorHighlight,
    lineNumbers(),
    search({ top: true }),
    EditorView.lineWrapping,
    EditorState.readOnly.of(true),
    EditorView.editable.of(false),
    keymap.of(searchKeymap),
    ...(languageSupport ? [languageSupport] : []),
  ];
}

function destroyMergeView() {
  mergeView?.destroy();
  mergeView = null;
}

function mountMergeView() {
  if (!containerRef.value) return;
  destroyMergeView();

  const extensions = editorExtensions(language.value);
  mergeView = new MergeView({
    a: {
      doc: parsed.value.oldText,
      extensions,
    },
    b: {
      doc: parsed.value.newText,
      extensions,
    },
    parent: containerRef.value,
    orientation: "a-b",
    gutter: true,
    highlightChanges: true,
    revertControls: undefined,
    collapseUnchanged: {
      margin: 4,
      minSize: 12,
    },
    diffConfig: {
      scanLimit: 4_000,
      timeout: 1_000,
    },
  });
}

onMounted(mountMergeView);

onBeforeUnmount(destroyMergeView);

watch(
  () => [props.filePath, props.content] as const,
  () => mountMergeView(),
);
</script>

<template>
  <div class="diff-merge-editor">
    <header class="toolbar">
      <span class="path" :title="parsed.filePath">{{ parsed.filePath }}</span>
      <span class="side-label removed">旧版本</span>
      <span class="side-label added">新版本</span>
    </header>
    <div ref="containerRef" class="merge-host" />
  </div>
</template>

<style scoped>
.diff-merge-editor {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  background: var(--bg);
}

.toolbar {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  align-items: center;
  gap: 8px;
  min-height: 30px;
  padding: 0 16px;
  background: var(--bg);
}

.path {
  min-width: 0;
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: monospace;
  font-size: 11px;
}

.side-label {
  border-radius: 999px;
  padding: 2px 7px;
  font-size: 11px;
}

.side-label.removed {
  background: color-mix(in srgb, var(--danger) 13%, transparent);
  color: var(--danger-muted);
}

.side-label.added {
  background: color-mix(in srgb, var(--success) 13%, transparent);
  color: var(--success);
}

.merge-host {
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.merge-host :deep(.cm-mergeView) {
  height: 100%;
  overflow: auto;
  background: var(--bg);
}

.merge-host :deep(.cm-mergeViewEditors) {
  min-height: 100%;
}

.merge-host :deep(.cm-editor) {
  height: 100%;
}

.merge-host :deep(.cm-scroller) {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}

.merge-host :deep(.cm-changedLine) {
  background: color-mix(in srgb, var(--accent) 15%, transparent);
}

.merge-host :deep(.cm-deletedLine) {
  background: color-mix(in srgb, var(--danger) 14%, transparent);
}

.merge-host :deep(.cm-insertedLine) {
  background: color-mix(in srgb, var(--success) 13%, transparent);
}

.merge-host :deep(.cm-changedText) {
  background: color-mix(in srgb, var(--attention) 24%, transparent);
}
</style>
