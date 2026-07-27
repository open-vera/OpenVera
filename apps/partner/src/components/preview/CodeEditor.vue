<script setup lang="ts">
import {
  LSPClient,
  LSPPlugin,
  languageServerExtensions,
} from "@codemirror/lsp-client";
import { showMinimap } from "@replit/codemirror-minimap";
import { search, searchKeymap } from "@codemirror/search";
import type { Extension } from "@codemirror/state";
import { Compartment, EditorState, Prec } from "@codemirror/state";
import { EditorView, keymap, lineNumbers, type ViewUpdate } from "@codemirror/view";
import { basicSetup } from "codemirror";
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { writeFile } from "@/bridge";
import { canFormatLanguage, formatPreviewDocument } from "@/preview/format";
import { pathToFileUri } from "@/preview/file-uri";
import { startLsp, stopLsp } from "@/bridge/lsp";
import {
  detectLanguage,
  isLspSupported,
  languageSupportFor,
  lspLanguageId,
  type PreviewLanguageId,
} from "@/preview/language";
import {
  canPreviewLanguage,
  previewKindForLanguage,
} from "@/preview/markdown-preview";
import {
  offsetFromLspPosition,
  parseLspDefinitionLocation,
  setPendingLspNavigation,
  takePendingLspNavigation,
} from "@/preview/lsp-navigation";
import { connectLspTransport } from "@/preview/lsp-transport";
import { resolveImportPathAtOffset } from "@/preview/resolve-import";
import { partnerEditorHighlight, partnerEditorTheme } from "@/preview/theme";
import { openWorkspaceFile } from "@/utils/open-workspace-file";
import {
  basenamePath,
  writePartnerSelectionClipboard,
} from "@/utils/partner-dnd";
import MarkdownRenderer from "@/components/chat/MarkdownRenderer.vue";

const props = defineProps<{
  filePath: string;
  content: string;
  savedContent?: string;
  workspaceRoot: string;
  languageId?: PreviewLanguageId;
  enableLsp?: boolean;
  readOnly?: boolean;
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
const documentPreviewOpen = ref(false);
const contextMenu = reactive<{
  visible: boolean;
  x: number;
  y: number;
  language: PreviewLanguageId | null;
  canFormat: boolean;
  canPreview: boolean;
}>({
  visible: false,
  x: 0,
  y: 0,
  language: null,
  canFormat: false,
  canPreview: false,
});
let view: EditorView | null = null;
let lspClient: LSPClient | null = null;
let activeServerId: string | null = null;
let lspSocketClose: (() => void) | null = null;
let lspCompartment: Compartment | null = null;
let mountRunId = 0;
let isApplyingExternalContent = false;
let lspReady = false;

const isDirty = computed(() => currentContent.value !== savedContent.value);
const previewLanguage = computed(() => {
  return props.languageId ?? detectLanguage(props.filePath, currentContent.value);
});
const previewKind = computed(() => previewKindForLanguage(previewLanguage.value));
const supportsDocumentPreview = computed(() => previewKind.value !== null);

function applyLspPosition(target: EditorView, line: number, character: number) {
  const pos = offsetFromLspPosition(target.state.doc, line, character);
  target.dispatch({
    selection: { anchor: pos },
    scrollIntoView: true,
    userEvent: "select.definition",
  });
}

function applyPendingNavigation(target: EditorView) {
  const pending = takePendingLspNavigation(props.filePath);
  if (!pending) return;
  applyLspPosition(target, pending.line, pending.character);
}

async function openImportFallback(target: EditorView, offset: number): Promise<boolean> {
  if (!props.workspaceRoot) return false;
  const path = await resolveImportPathAtOffset({
    doc: target.state.doc.toString(),
    offset,
    workspaceRoot: props.workspaceRoot,
    fromFilePath: props.filePath,
  });
  if (!path) return false;
  return openWorkspaceFile(path);
}

/** Jump to definition; open other files in Partner preview tabs. */
function partnerJumpToDefinition(target: EditorView): boolean {
  const offset = target.state.selection.main.head;
  const plugin = LSPPlugin.get(target);
  if (
    !plugin ||
    !lspReady ||
    plugin.client.serverCapabilities?.definitionProvider === false
  ) {
    void openImportFallback(target, offset).then((opened) => {
      if (!opened) {
        console.warn(
          "[CodeEditor] Go to definition unavailable (LSP not ready / no import path).",
        );
      }
    });
    return true;
  }

  plugin.client.sync();
  plugin.client.withMapping((mapping) =>
    plugin.client
      .request("textDocument/definition", {
        textDocument: { uri: plugin.uri },
        position: plugin.toPosition(offset),
      })
      .then(async (response) => {
        const location = parseLspDefinitionLocation(response);
        if (!location) {
          const opened = await openImportFallback(target, offset);
          if (!opened) {
            console.warn("[CodeEditor] No definition found at cursor.");
          }
          return;
        }

        if (location.uri === plugin.uri) {
          const pos = mapping.getMapping(location.uri)
            ? mapping.mapPosition(location.uri, {
                line: location.line,
                character: location.character,
              })
            : offsetFromLspPosition(target.state.doc, location.line, location.character);
          target.dispatch({
            selection: { anchor: pos },
            scrollIntoView: true,
            userEvent: "select.definition",
          });
          return;
        }

        setPendingLspNavigation({
          path: location.path,
          line: location.line,
          character: location.character,
        });
        const opened = await openWorkspaceFile(location.path);
        if (!opened) {
          setPendingLspNavigation(null);
          await openImportFallback(target, offset);
        }
      })
      .catch(async (error: unknown) => {
        plugin.reportError("Find definition failed", error);
        await openImportFallback(target, offset);
      }),
  );
  return true;
}

async function saveCurrentFile(): Promise<void> {
  if (props.readOnly) return;
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
  contextMenu.canFormat = false;
  contextMenu.canPreview = false;
}

function showContextMenu(event: MouseEvent, language: PreviewLanguageId) {
  const canFormat = canFormatLanguage(language) && !props.readOnly;
  const canPreview = canPreviewLanguage(language);
  if (!canFormat && !canPreview) {
    hideContextMenu();
    return;
  }

  event.preventDefault();
  contextMenu.visible = true;
  contextMenu.language = language;
  contextMenu.canFormat = canFormat;
  contextMenu.canPreview = canPreview;
  contextMenu.x = Math.min(event.clientX, window.innerWidth - 180);
  contextMenu.y = Math.min(event.clientY, window.innerHeight - 88);
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

function setDocumentView(mode: "edit" | "preview") {
  hideContextMenu();
  documentPreviewOpen.value = mode === "preview";
}

function onGlobalKeydown(event: KeyboardEvent) {
  if (event.key === "Escape") {
    if (contextMenu.visible) {
      hideContextMenu();
      return;
    }
    if (documentPreviewOpen.value) {
      setDocumentView("edit");
    }
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
  // Same chevron glyph as FileTreeNode / ProjectSessionTree.
  toggle.innerHTML =
    '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 8l5 5 5-5" /></svg>';
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
    // Keep long lines intact; panel scrolls horizontally instead of wrapping.
    EditorState.readOnly.of(Boolean(props.readOnly)),
    EditorView.editable.of(!props.readOnly),
    EditorView.domEventHandlers({
      contextmenu: (event) => {
        showContextMenu(event, language);
        return true;
      },
      copy: (event, editorView) => {
        const selection = editorView.state.selection.main;
        if (selection.empty || !event.clipboardData) return false;
        const content = editorView.state.sliceDoc(selection.from, selection.to);
        if (!content) return false;
        const startLine = editorView.state.doc.lineAt(selection.from).number;
        const endLine = editorView.state.doc.lineAt(selection.to).number;
        writePartnerSelectionClipboard(event.clipboardData, {
          path: props.filePath,
          name: basenamePath(props.filePath),
          content,
          startLine,
          endLine,
        });
        event.preventDefault();
        return true;
      },
      click: (event, editorView) => {
        // Cmd/Ctrl+click — IDE-style go to definition
        const modClick = (event.metaKey || event.ctrlKey) && event.button === 0;
        // Plain click on an import string also jumps (Partner UX).
        const pos = editorView.posAtCoords({ x: event.clientX, y: event.clientY });
        if (pos == null) return false;

        if (!modClick) {
          // Plain click only hijacks when inside a quoted path on an import line.
          const line = editorView.state.doc.lineAt(pos);
          const lineText = line.text;
          const looksLikeImport =
            /\b(import|export|from|require)\b/.test(lineText) &&
            /['"][^'"]+['"]/.test(lineText);
          if (!looksLikeImport) return false;
          const local = pos - line.from;
          const inString = [...lineText.matchAll(/['"][^'"]*['"]/g)].some((match) => {
            const start = match.index ?? 0;
            return local >= start && local <= start + match[0].length;
          });
          if (!inString) return false;
        }

        event.preventDefault();
        editorView.dispatch({ selection: { anchor: pos } });
        return partnerJumpToDefinition(editorView);
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
    if (runId !== mountRunId) {
      void stopLsp(result.serverId);
      return [];
    }

    const handle = await connectLspTransport(result.wsUrl);
    if (runId !== mountRunId) {
      handle.close();
      void stopLsp(result.serverId);
      return [];
    }

    activeServerId = result.serverId;
    lspSocketClose = handle.close;
    lspClient?.disconnect();
    // languageServerExtensions already includes hover / completion / diagnostics once.
    lspClient = new LSPClient({
      rootUri: pathToFileUri(props.workspaceRoot),
      timeout: 12_000,
      extensions: languageServerExtensions(),
    }).connect(handle.transport);

    await lspClient.initializing;
    if (runId !== mountRunId) return [];
    const lspId = lspLanguageId(language);
    if (!lspId) return [];

    lspReady = true;
    console.info("[CodeEditor] LSP ready:", lspId, props.filePath);
    return [
      lspClient.plugin(pathToFileUri(props.filePath), lspId),
      // Override bundled F12 so cross-file jumps open Partner tabs.
      Prec.highest(
        keymap.of([
          {
            key: "F12",
            run: partnerJumpToDefinition,
            preventDefault: true,
          },
        ]),
      ),
    ];
  } catch (error) {
    lspReady = false;
    console.warn("[CodeEditor] LSP unavailable:", error);
    return [];
  }
}

async function mountEditor() {
  if (!containerRef.value) return;

  destroyEditor();

  // Re-detect when tab was saved as plaintext (e.g. extensionless shell hooks).
  const language =
    props.languageId && props.languageId !== "plaintext"
      ? props.languageId
      : detectLanguage(props.filePath, props.content);
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
      applyPendingNavigation(view);
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
  lspReady = false;
  lspClient?.disconnect();
  lspClient = null;
  lspSocketClose?.();
  lspSocketClose = null;
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
    documentPreviewOpen.value = false;
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
      <div
        v-if="supportsDocumentPreview"
        class="view-switch"
        role="group"
        aria-label="文档视图"
      >
        <button
          type="button"
          class="view-switch-btn"
          :class="{ active: !documentPreviewOpen }"
          @click="setDocumentView('edit')"
        >
          编辑
        </button>
        <button
          type="button"
          class="view-switch-btn"
          :class="{ active: documentPreviewOpen }"
          @click="setDocumentView('preview')"
        >
          预览
        </button>
      </div>
    </header>
    <div v-show="!documentPreviewOpen" ref="containerRef" class="editor-host" />
    <div
      v-if="documentPreviewOpen && previewKind === 'markdown'"
      class="document-preview-pane markdown-preview-pane"
      @contextmenu="showContextMenu($event, previewLanguage)"
    >
      <MarkdownRenderer :content="currentContent" />
    </div>
    <div
      v-else-if="documentPreviewOpen && previewKind === 'html'"
      class="document-preview-pane html-preview-pane"
      @contextmenu="showContextMenu($event, previewLanguage)"
    >
      <iframe
        class="html-preview-frame"
        sandbox=""
        referrerpolicy="no-referrer"
        :srcdoc="currentContent"
        title="HTML preview"
      />
    </div>
    <pre
      v-else-if="documentPreviewOpen && previewKind === 'text'"
      class="document-preview-pane text-preview-pane"
      @contextmenu="showContextMenu($event, previewLanguage)"
    >{{ currentContent }}</pre>
    <div
      v-if="contextMenu.visible"
      class="editor-context-menu"
      :style="{ left: `${contextMenu.x}px`, top: `${contextMenu.y}px` }"
      @click.stop
      @contextmenu.prevent
      @mousedown.stop
    >
      <button
        v-if="contextMenu.canPreview && !documentPreviewOpen"
        type="button"
        @click="setDocumentView('preview')"
      >
        预览
      </button>
      <button
        v-if="contextMenu.canPreview && documentPreviewOpen"
        type="button"
        @click="setDocumentView('edit')"
      >
        编辑
      </button>
      <button
        v-if="contextMenu.canFormat && !documentPreviewOpen"
        type="button"
        @click="onFormatMenuClick"
      >
        格式化文档
      </button>
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
  background: var(--bg);
}

.toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 30px;
  padding: 0 16px;
  background: var(--bg);
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
  color: var(--danger-muted);
}

.view-switch {
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  padding: 2px;
  border: 1px solid color-mix(in srgb, var(--border) 80%, transparent);
  border-radius: 7px;
  background: color-mix(in srgb, var(--surface) 70%, transparent);
}

.view-switch-btn {
  height: 20px;
  border: none;
  border-radius: 5px;
  padding: 0 8px;
  background: transparent;
  color: var(--text-muted);
  font: inherit;
  font-size: 11px;
  cursor: pointer;
}

.view-switch-btn:hover {
  color: var(--text);
}

.view-switch-btn.active {
  color: var(--text);
  background: color-mix(in srgb, var(--surface-hover) 88%, transparent);
}

.document-preview-pane {
  flex: 1;
  min-height: 0;
  overflow: auto;
  background: var(--bg);
  color: var(--text);
}

.markdown-preview-pane {
  padding: 16px 20px 28px;
}

.markdown-preview-pane :deep(.markdown-renderer) {
  max-width: 860px;
  margin: 0 auto;
  font-size: 14px;
  line-height: 1.65;
}

.html-preview-pane {
  display: flex;
  overflow: hidden;
  padding: 0;
  background: #fff;
}

.html-preview-frame {
  flex: 1;
  width: 100%;
  height: 100%;
  border: 0;
  background: #fff;
}

.text-preview-pane {
  margin: 0;
  padding: 16px 20px 28px;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 13px;
  line-height: 1.55;
}

.editor-context-menu {
  position: fixed;
  z-index: 1000;
  min-width: 160px;
  padding: 4px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface-elevated-solid, var(--surface-solid, var(--surface)));
  -webkit-backdrop-filter: none;
  backdrop-filter: none;
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
