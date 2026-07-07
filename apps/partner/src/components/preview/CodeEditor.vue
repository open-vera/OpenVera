<script setup lang="ts">
import {
  LSPClient,
  hoverTooltips,
  jumpToDefinitionKeymap,
  languageServerExtensions,
  serverDiagnostics,
} from "@codemirror/lsp-client";
import { showMinimap } from "@replit/codemirror-minimap";
import { search, searchKeymap } from "@codemirror/search";
import type { Extension } from "@codemirror/state";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, keymap, lineNumbers, type ViewUpdate } from "@codemirror/view";
import { basicSetup } from "codemirror";
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { writeFile } from "@/bridge";
import { canFormatLanguage, formatPreviewDocument } from "@/preview/format";
import { startLsp, stopLsp } from "@/bridge/lsp";
import {
  detectLanguageFromPath,
  isLspSupported,
  languageSupportFor,
  lspLanguageId,
  type PreviewLanguageId,
} from "@/preview/language";
import { createWebSocketTransport, waitForWebSocketOpen } from "@/preview/lsp-transport";
import { partnerEditorHighlight, partnerEditorTheme } from "@/preview/theme";

const props = defineProps<{
  filePath: string;
  content: string;
  savedContent?: string;
  workspaceRoot: string;
  languageId?: PreviewLanguageId;
  enableLsp?: boolean;
}>();

const emit = defineEmits<{
  change: [content: string];
  saved: [content: string];
}>();

const containerRef = ref<HTMLDivElement | null>(null);
const currentContent = ref(props.content);
const savedContent = ref(props.content);
const isSaving = ref(false);
const saveError = ref("");
const formatError = ref("");
const contextMenu = reactive<{
  visible: boolean;
  x: number;
  y: number;
  language: PreviewLanguageId | null;
}>({
  visible: false,
  x: 0,
  y: 0,
  language: null,
});
let view: EditorView | null = null;
let lspClient: LSPClient | null = null;
let activeServerId: string | null = null;
let lspCompartment: Compartment | null = null;
let mountRunId = 0;
let isApplyingExternalContent = false;

function pathToFileUri(path: string): string {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return `file://${normalized}`;
}

const isDirty = computed(() => currentContent.value !== savedContent.value);

async function saveCurrentFile(): Promise<void> {
  if (!isDirty.value || isSaving.value) return;
  isSaving.value = true;
  saveError.value = "";
  try {
    const content = currentContent.value;
    await writeFile(props.filePath, content);
    savedContent.value = content;
    emit("saved", content);
  } catch (error) {
    saveError.value = error instanceof Error ? error.message : String(error);
  } finally {
    isSaving.value = false;
  }
}

function onEditorUpdate(update: ViewUpdate) {
  if (!update.docChanged) return;
  formatError.value = "";
  currentContent.value = update.state.doc.toString();
  if (isApplyingExternalContent) return;
  emit("change", currentContent.value);
}

function hideContextMenu() {
  contextMenu.visible = false;
  contextMenu.language = null;
}

function showContextMenu(event: MouseEvent, language: PreviewLanguageId) {
  if (!canFormatLanguage(language)) {
    hideContextMenu();
    return;
  }

  event.preventDefault();
  contextMenu.visible = true;
  contextMenu.language = language;
  contextMenu.x = Math.min(event.clientX, window.innerWidth - 180);
  contextMenu.y = Math.min(event.clientY, window.innerHeight - 48);
}

async function formatDocument(language: PreviewLanguageId): Promise<void> {
  if (!view) return;
  formatError.value = "";
  const content = view.state.doc.toString();
  try {
    const formatted = await formatPreviewDocument(props.filePath, language, content);
    if (formatted === content || !view) return;
    view.dispatch({
      changes: {
        from: 0,
        to: view.state.doc.length,
        insert: formatted,
      },
    });
  } catch (error) {
    formatError.value = error instanceof Error ? error.message : String(error);
  }
}

function onFormatMenuClick() {
  const language = contextMenu.language;
  hideContextMenu();
  if (language) {
    void formatDocument(language);
  }
}

function onGlobalKeydown(event: KeyboardEvent) {
  if (event.key === "Escape") {
    hideContextMenu();
  }
}

function syncSearchPanel(view: EditorView) {
  const panel = view.dom.querySelector<HTMLElement>(".cm-panel.cm-search");
  if (!panel || panel.querySelector(".partner-search-toggle")) return;

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "partner-search-toggle";
  toggle.setAttribute("aria-label", "展开替换");
  toggle.setAttribute("aria-expanded", "false");
  toggle.addEventListener("click", () => {
    const isOpen = panel.classList.toggle("partner-search-replace-open");
    toggle.setAttribute("aria-expanded", String(isOpen));
    toggle.setAttribute("aria-label", isOpen ? "折叠替换" : "展开替换");
  });
  panel.insertBefore(toggle, panel.firstChild);
}

function syncFloatingMinimap(view: EditorView) {
  const editorRoot = view.dom;
  const minimap = editorRoot.querySelector<HTMLElement>(".partner-floating-minimap");
  if (!minimap || minimap.parentElement === editorRoot) return;
  minimap.removeAttribute("style");
  editorRoot.appendChild(minimap);
}

function onViewUpdate(update: ViewUpdate) {
  onEditorUpdate(update);
  syncSearchPanel(update.view);
  syncFloatingMinimap(update.view);
}

function buildExtensions(language: PreviewLanguageId): Extension[] {
  const languageSupport = languageSupportFor(language);
  const extensions: Extension[] = [
    basicSetup,
    partnerEditorTheme,
    partnerEditorHighlight,
    lineNumbers(),
    search({ top: true }),
    showMinimap.compute(["doc"], () => ({
      create: () => {
        const dom = document.createElement("div");
        dom.className = "partner-floating-minimap";
        return { dom };
      },
      displayText: "characters",
      showOverlay: "always",
      eventHandlers: {
        contextmenu: (event) => {
          event.preventDefault();
        },
      },
    })),
    EditorView.lineWrapping,
    EditorView.domEventHandlers({
      contextmenu: (event) => {
        showContextMenu(event, language);
        return true;
      },
    }),
    EditorView.updateListener.of(onViewUpdate),
    keymap.of([
      ...searchKeymap,
      {
        key: "Mod-s",
        run: () => {
          void saveCurrentFile();
          return true;
        },
      },
    ]),
  ];
  if (languageSupport) {
    extensions.push(languageSupport);
  }
  return extensions;
}

async function connectLsp(
  language: PreviewLanguageId,
  runId: number,
): Promise<Extension[]> {
  if (!props.enableLsp || !isLspSupported(language) || !props.workspaceRoot) {
    return [];
  }

  try {
    const result = await startLsp(language, props.workspaceRoot, props.filePath);
    await waitForWebSocketOpen(result.wsUrl);
    if (runId !== mountRunId) {
      void stopLsp(result.serverId);
      return [];
    }
    activeServerId = result.serverId;

    lspClient?.disconnect();
    lspClient = new LSPClient({
      rootUri: pathToFileUri(props.workspaceRoot),
      extensions: [...languageServerExtensions(), serverDiagnostics()],
    }).connect(createWebSocketTransport(result.wsUrl));

    await lspClient.initializing;
    if (runId !== mountRunId) return [];
    const lspId = lspLanguageId(language);
    if (!lspId) return [];

    return [
      lspClient.plugin(pathToFileUri(props.filePath), lspId),
      hoverTooltips(),
      keymap.of(jumpToDefinitionKeymap),
    ];
  } catch (error) {
    console.warn("[CodeEditor] LSP unavailable:", error);
    return [];
  }
}

async function mountEditor() {
  if (!containerRef.value) return;

  destroyEditor();

  const language = props.languageId ?? detectLanguageFromPath(props.filePath);
  lspCompartment = new Compartment();
  const runId = ++mountRunId;
  currentContent.value = props.content;
  savedContent.value = props.savedContent ?? props.content;
  saveError.value = "";

  view = new EditorView({
    state: EditorState.create({
      doc: props.content,
      extensions: [...buildExtensions(language), lspCompartment.of([])],
    }),
    parent: containerRef.value,
  });
  syncFloatingMinimap(view);
  requestAnimationFrame(() => {
    if (view && runId === mountRunId) {
      syncFloatingMinimap(view);
    }
  });

  void connectLsp(language, runId).then((lspExtensions) => {
    if (
      runId !== mountRunId ||
      !view ||
      !lspCompartment ||
      lspExtensions.length === 0
    ) {
      return;
    }
    view.dispatch({
      effects: lspCompartment.reconfigure(lspExtensions),
    });
  });
}

function destroyEditor() {
  hideContextMenu();
  mountRunId += 1;
  view?.destroy();
  view = null;
  lspCompartment = null;
  lspClient?.disconnect();
  lspClient = null;
  if (activeServerId) {
    void stopLsp(activeServerId);
    activeServerId = null;
  }
}

onMounted(() => {
  window.addEventListener("click", hideContextMenu);
  window.addEventListener("keydown", onGlobalKeydown);
  window.addEventListener("resize", hideContextMenu);
  void mountEditor();
});

onBeforeUnmount(() => {
  window.removeEventListener("click", hideContextMenu);
  window.removeEventListener("keydown", onGlobalKeydown);
  window.removeEventListener("resize", hideContextMenu);
  destroyEditor();
});

watch(
  () => [props.filePath, props.enableLsp] as const,
  () => {
    void mountEditor();
  },
);

watch(
  () => [props.content, props.savedContent] as const,
  ([content, nextSavedContent]) => {
    const wasDirty = currentContent.value !== savedContent.value;
    if (wasDirty && currentContent.value !== content) return;
    savedContent.value = nextSavedContent ?? content;
    if (!view || wasDirty) return;
    const currentDoc = view.state.doc.toString();
    if (currentDoc === content) return;
    isApplyingExternalContent = true;
    view.dispatch({
      changes: {
        from: 0,
        to: view.state.doc.length,
        insert: content,
      },
    });
    isApplyingExternalContent = false;
    currentContent.value = content;
    savedContent.value = nextSavedContent ?? content;
  },
);
</script>

<template>
  <div class="code-editor">
    <header class="toolbar">
      <span class="path" :title="filePath">{{ filePath }}</span>
      <span v-if="saveError" class="save-error" :title="saveError">保存失败</span>
      <span v-if="formatError" class="format-error" :title="formatError">格式化失败</span>
    </header>
    <div ref="containerRef" class="editor-host" />
    <div
      v-if="contextMenu.visible"
      class="editor-context-menu"
      :style="{ left: `${contextMenu.x}px`, top: `${contextMenu.y}px` }"
      @click.stop
      @contextmenu.prevent
      @mousedown.stop
    >
      <button type="button" @click="onFormatMenuClick">格式化文档</button>
    </div>
  </div>
</template>

<style scoped>
.code-editor {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  background: #1f2023;
}

.toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 30px;
  padding: 0 16px;
  background: #1f2023;
}

.path {
  flex: 1;
  min-width: 0;
  font-size: 11px;
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: monospace;
}

.save-error,
.format-error {
  flex-shrink: 0;
  font-size: 11px;
}

.save-error,
.format-error {
  color: #f28b82;
}

.editor-context-menu {
  position: fixed;
  z-index: 1000;
  min-width: 160px;
  padding: 4px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface);
  box-shadow: 0 8px 24px rgb(0 0 0 / 35%);
}

.editor-context-menu button {
  width: 100%;
  border: 0;
  border-radius: 4px;
  padding: 6px 10px;
  color: var(--text);
  background: transparent;
  text-align: left;
  cursor: pointer;
}

.editor-context-menu button:hover {
  background: var(--surface-hover);
}

.editor-host {
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.editor-host :deep(.cm-editor) {
  height: 100%;
}
</style>
