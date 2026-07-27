<script setup lang="ts">
import { getCurrentWindow } from "@tauri-apps/api/window";
import { storeToRefs } from "pinia";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import LeftPanel from "@/components/left/LeftPanel.vue";
import ChatPanel from "@/components/chat/ChatPanel.vue";
import PreviewPanel from "@/components/preview/PreviewPanel.vue";
import TerminalPanel from "@/components/terminal/TerminalPanel.vue";
import PanelToggleButton from "@/components/ui/PanelToggleButton.vue";
import { getSidecarInfo, type SidecarInfo } from "@/bridge/agent";
import { registerPartnerAppEvents } from "@/bridge/events";
import SidecarUnavailableDialog from "@/components/SidecarUnavailableDialog.vue";
import ImageLightbox from "@/components/ui/ImageLightbox.vue";
import QuickOpenDialog from "@/components/explorer/QuickOpenDialog.vue";
import { registerPartnerShortcuts } from "@/shortcuts/partner-shortcuts";
import { useAppStateStore } from "@/stores/app-state";
import { useChatStore } from "@/stores/chat";
import { usePreviewStore } from "@/stores/preview";
import { useSessionStore } from "@/stores/session";
import { useModelCatalogStore } from "@/stores/model-catalog";
import { useSettingsStore } from "@/stores/settings";
import { useTerminalStore } from "@/stores/terminal";
import { useWorkspaceStore } from "@/stores/workspace";
import type { LayoutSnapshot } from "@/types";
import { measureAsync, setPerfLogRoot } from "@/perf";
import {
  disposePartnerTray,
  initPartnerTray,
  schedulePartnerTrayRefresh,
} from "@/tray/partner-tray";
import { closeFocusedWorkAreaTab } from "@/shortcuts/partner-shortcuts";
import { useHostStore } from "@/shell";
const preview = usePreviewStore();
const host = useHostStore();
const chat = useChatStore();
const session = useSessionStore();
const settings = useSettingsStore();
const modelCatalog = useModelCatalogStore();
const workspace = useWorkspaceStore();
const terminal = useTerminalStore();
const appState = useAppStateStore();
const { rootPath } = storeToRefs(workspace);
const { open: terminalOpen, height: terminalHeight } = storeToRefs(terminal);
const chatPanelRef = ref<InstanceType<typeof ChatPanel> | null>(null);
const sidecarDialog = ref<SidecarInfo | null>(null);
let colorSchemeMedia: MediaQueryList | undefined;

const LAYOUT_STORAGE_KEY_PREFIX = "partner:layout";
const DEFAULT_LEFT_WIDTH = 240;
const DEFAULT_PREVIEW_WIDTH = 640;
const DEFAULT_TERMINAL_HEIGHT = 260;
/** When a file opens, grow the right workspace up to this if currently narrower. */
const COMFORTABLE_PREVIEW_WIDTH = 720;
const MIN_LEFT_WIDTH = 200;
const MIN_PREVIEW_WIDTH = 320;
const MIN_CENTER_WIDTH = 360;
const MIN_TERMINAL_HEIGHT = 120;
const COLLAPSED_RAIL = 36;

const leftWidth = ref(DEFAULT_LEFT_WIDTH);
const previewWidth = ref(DEFAULT_PREVIEW_WIDTH);
const leftOpen = ref(true);
const previewOpen = ref(true);
const explorerOpen = ref(true);
const editorOpen = ref(true);
const resizing = ref<"left" | "preview" | "terminal" | null>(null);
const initialWindowId = getCurrentWindow().label || "main";
const currentWindowId = ref(initialWindowId);
let unregisterAppEvents: (() => void) | undefined;
let unregisterShortcuts: (() => void) | undefined;

session.setWindowId(initialWindowId);
workspace.setWindowId(initialWindowId);

const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max);

/**
 * Files & preview only make sense with a project open — without one the column
 * collapses entirely instead of floating an "open a folder" hint over the chat.
 */
const hasPreviewProject = computed(() => Boolean(appState.previewProject));
const previewVisible = computed(() => previewOpen.value && hasPreviewProject.value);
const previewRailVisible = computed(() => !previewOpen.value && hasPreviewProject.value);

function previewColumnWidth(): number {
  if (previewVisible.value) return previewWidth.value;
  return previewRailVisible.value ? COLLAPSED_RAIL : 0;
}

const layoutStyle = computed(() => ({
  "--left-w": `${leftOpen.value ? leftWidth.value : COLLAPSED_RAIL}px`,
  "--preview-w": `${previewColumnWidth()}px`,
  "--center-min": `${MIN_CENTER_WIDTH}px`,
  "--terminal-h": `${terminalOpen.value ? terminalHeight.value : 0}px`,
}));

const panelToggleText = computed(() =>
  settings.locale === "en"
    ? {
        expandLeft: "Expand projects & sessions",
        expandPreview: "Expand files & preview",
      }
    : {
        expandLeft: "展开项目与会话",
        expandPreview: "展开文件与预览",
      },
);

function readStoredNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readStoredBool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function layoutStorageKey(windowId = currentWindowId.value): string {
  return `${LAYOUT_STORAGE_KEY_PREFIX}:${windowId}`;
}

function currentLayoutSnapshot(): LayoutSnapshot {
  return {
    leftWidth: leftWidth.value,
    previewWidth: previewWidth.value,
    leftOpen: leftOpen.value,
    previewOpen: previewOpen.value,
    explorerOpen: explorerOpen.value,
    editorOpen: editorOpen.value,
    terminalOpen: terminalOpen.value,
    terminalHeight: terminalHeight.value,
  };
}

function applyLayoutSnapshot(layout: LayoutSnapshot) {
  const viewportWidth = window.innerWidth;
  leftWidth.value = clamp(layout.leftWidth, MIN_LEFT_WIDTH, Math.floor(viewportWidth / 2));
  previewWidth.value = clamp(
    layout.previewWidth,
    MIN_PREVIEW_WIDTH,
    Math.max(MIN_PREVIEW_WIDTH, maxPreviewWidth(viewportWidth)),
  );
  leftOpen.value = layout.leftOpen !== false;
  previewOpen.value = layout.previewOpen !== false;
  explorerOpen.value = layout.explorerOpen !== false;
  editorOpen.value = layout.editorOpen !== false;
  terminal.setOpen(layout.terminalOpen === true);
  if (typeof layout.terminalHeight === "number") {
    terminal.setHeight(
      clamp(
        layout.terminalHeight,
        MIN_TERMINAL_HEIGHT,
        Math.floor(window.innerHeight * 0.7),
      ),
    );
  }
}

function restoreLayout() {
  try {
    const raw =
      window.localStorage.getItem(layoutStorageKey()) ??
      window.localStorage.getItem(LAYOUT_STORAGE_KEY_PREFIX);
    if (!raw) return;

    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const storedLeftWidth = readStoredNumber(parsed.leftWidth);
    const storedPreviewWidth = readStoredNumber(parsed.previewWidth);

    if (storedLeftWidth !== null) {
      leftWidth.value = storedLeftWidth;
    }
    if (storedPreviewWidth !== null) {
      previewWidth.value = storedPreviewWidth;
    }
    leftOpen.value = readStoredBool(parsed.leftOpen, true);
    previewOpen.value = readStoredBool(parsed.previewOpen, true);
    explorerOpen.value = readStoredBool(parsed.explorerOpen, true);
    editorOpen.value = readStoredBool(parsed.editorOpen, true);
    terminal.setOpen(readStoredBool(parsed.terminalOpen, false));
    const storedTerminalHeight = readStoredNumber(parsed.terminalHeight);
    if (storedTerminalHeight !== null) {
      terminal.setHeight(storedTerminalHeight);
    } else {
      terminal.setHeight(DEFAULT_TERMINAL_HEIGHT);
    }
    applyLayoutSnapshot(currentLayoutSnapshot());
  } catch (error) {
    console.warn("[Layout] failed to restore layout:", error);
  }
}

function setLeftOpen(open: boolean) {
  leftOpen.value = open;
  persistLayout();
  schedulePersistHost();
}

function setPreviewOpen(open: boolean) {
  previewOpen.value = open;
  persistLayout();
  schedulePersistHost();
}

function persistLayout() {
  window.localStorage.setItem(
    layoutStorageKey(),
    JSON.stringify(currentLayoutSnapshot()),
  );
}

function stopResize() {
  if (resizing.value) {
    persistLayout();
    schedulePersistHost();
  }
  resizing.value = null;
  window.removeEventListener("pointermove", onPointerMove);
  window.removeEventListener("pointerup", stopResize);
}

function schedulePersistHost() {
  if (!appState.isLoaded) return;
  appState.schedulePersist();
}

function maxPreviewWidth(viewportWidth = window.innerWidth): number {
  const occupiedLeft = leftOpen.value ? leftWidth.value : COLLAPSED_RAIL;
  return Math.min(
    Math.floor(viewportWidth * 0.55),
    viewportWidth - occupiedLeft - MIN_CENTER_WIDTH,
  );
}

function ensureComfortablePreviewWidth() {
  const maxWidth = Math.max(MIN_PREVIEW_WIDTH, maxPreviewWidth());
  const target = Math.min(COMFORTABLE_PREVIEW_WIDTH, maxWidth);
  if (previewWidth.value >= target) return;
  previewWidth.value = target;
  persistLayout();
  schedulePersistHost();
}

function onPointerMove(event: PointerEvent) {
  const viewportWidth = window.innerWidth;
  if (resizing.value === "left") {
    leftWidth.value = clamp(event.clientX, MIN_LEFT_WIDTH, Math.floor(viewportWidth / 2));
    return;
  }
  if (resizing.value === "preview") {
    const nextWidth = viewportWidth - event.clientX;
    const maxWidth = maxPreviewWidth(viewportWidth);
    previewWidth.value = clamp(nextWidth, MIN_PREVIEW_WIDTH, Math.max(MIN_PREVIEW_WIDTH, maxWidth));
    return;
  }
  if (resizing.value === "terminal") {
    const nextHeight = window.innerHeight - event.clientY;
    terminal.setHeight(
      clamp(nextHeight, MIN_TERMINAL_HEIGHT, Math.floor(window.innerHeight * 0.7)),
    );
  }
}

function startResize(target: "left" | "preview" | "terminal", event: PointerEvent) {
  event.preventDefault();
  resizing.value = target;
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", stopResize, { once: true });
}

function showSidecarUnavailable(info: SidecarInfo) {
  if (info.running) return;
  sidecarDialog.value = info;
}

function syncPartnerTheme() {
  settings.applyAppearance();
}

/**
 * Boot data loading must never abort onMounted: shortcuts, menu events and tray
 * are registered after it, and an unguarded IPC rejection would leave the whole
 * window inert (dead Cmd+P / Cmd+`) with no visible cause.
 */
async function bootStep(label: string, run: () => Promise<unknown>) {
  try {
    await run();
  } catch (error) {
    console.error(`[App] boot step "${label}" failed:`, error);
  }
}

function onColorSchemeChange() {
  if (settings.theme === "system") {
    syncPartnerTheme();
  }
}

function syncChatFromAppState() {
  if (!appState.isLoaded) return;
  if (
    Object.keys(appState.sessions).length === 0 &&
    appState.openTabIds.length === 0
  ) {
    const id = appState.createSession({ projectId: appState.previewProjectId });
    const created = appState.getSession(id);
    if (created) chat.ensureSessionTab(created);
    return;
  }
  chat.syncFromOpenTabIds(
    appState.openTabIds,
    appState.sessions,
    appState.activeTabId,
  );
  if (appState.previewProject?.preview) {
    preview.restoreSnapshot(appState.previewProject.preview);
  }
}

function onJumpMessage(messageId: string) {
  chatPanelRef.value?.jumpToMessage(messageId);
}

function openSettings() {
  // Open the chat settings tab first so UI responds even if Host persist is slow.
  chat.openSettingsTab();
  appState.openSettingsTab();
}

function selectSessionFromTray(sessionId: string) {
  const sessionRecord = appState.getSession(sessionId);
  if (!sessionRecord) return;
  appState.openSession(sessionId, { activate: true });
  chat.ensureSessionTab(sessionRecord);
}

function createChatFromTray() {
  const id = appState.createSession({ projectId: appState.previewProjectId });
  const created = appState.getSession(id);
  if (created) chat.ensureSessionTab(created);
}

onMounted(async () => {
  const bootStarted = performance.now();
  setPerfLogRoot(workspace.rootPath || null);
  restoreLayout();

  // Wave 0: Rust Workbench Host is the source of truth for app/workspace/session.
  await bootStep("host", () =>
    measureAsync("boot.host", () => host.boot(), {
      warnMs: 40,
      errorMs: 300,
      recordOnlySlow: false,
    }),
  );

  await bootStep("settings", () =>
    measureAsync("boot.settings", () => settings.load(), {
      warnMs: 16,
      errorMs: 120,
      recordOnlySlow: false,
    }),
  );
  syncPartnerTheme();
  colorSchemeMedia = window.matchMedia("(prefers-color-scheme: light)");
  colorSchemeMedia.addEventListener("change", onColorSchemeChange);

  // Restore last workspace root early so the model catalog can resolve
  // project-scoped LLM config before ProjectExplorer finishes opening the folder.
  const bootProjectRoot = workspace.rootPath || workspace.restoreRoot() || null;

  // Independent boot work can overlap; don't serialize sidecar / catalog / app-state.
  await bootStep("parallel", () =>
    measureAsync(
      "boot.parallel",
      () =>
        Promise.all([
          getSidecarInfo()
            .then((sidecarInfo) => {
              showSidecarUnavailable(sidecarInfo);
            })
            .catch((error: unknown) => {
              console.warn("[App] failed to query sidecar status:", error);
            }),
          modelCatalog.loadProviders(bootProjectRoot || undefined),
          appState.isLoaded
            ? Promise.resolve()
            : appState.load().then(() => {
                syncChatFromAppState();
              }),
        ]),
      {
        warnMs: 40,
        errorMs: 300,
        recordOnlySlow: false,
      },
    ),
  );

  if (settings.provider.id) {
    void modelCatalog.ensureProviderModels(
      workspace.rootPath || undefined,
      settings.provider.id,
    );
  }

  unregisterShortcuts = registerPartnerShortcuts();
  unregisterAppEvents = await registerPartnerAppEvents({
    onOpenSettings: openSettings,
    onCloseTab: () => {
      closeFocusedWorkAreaTab();
    },
    onSidecarUnavailable: showSidecarUnavailable,
  });

  // Tray can wait until after first paint.
  window.setTimeout(() => {
    void initPartnerTray({
      onSelectSession: selectSessionFromTray,
      onNewChat: createChatFromTray,
    });
  }, 0);

  console.info(
    `[BootPerf] App mounted ${Math.round(performance.now() - bootStarted)}ms`,
  );
});

onBeforeUnmount(() => {
  colorSchemeMedia?.removeEventListener("change", onColorSchemeChange);
  unregisterAppEvents?.();
  unregisterShortcuts?.();
  void disposePartnerTray();
  stopResize();
  host.dispose();
});

watch(
  () => [
    settings.theme,
    settings.wallpaperMode,
    settings.wallpaperOpacity,
    settings.wallpaperBlur,
    settings.wallpaperDataUrl,
    settings.customPaletteId,
  ],
  () => {
    syncPartnerTheme();
  },
);

watch(rootPath, (projectRoot) => {
  setPerfLogRoot(projectRoot || null);
});

watch(
  rootPath,
  (projectRoot) => {
    if (!projectRoot) return;
    modelCatalog.reset();
    void settings.load(projectRoot);
    void modelCatalog.loadProviders(projectRoot, true);
    void appState.load().then(() => {
      appState.ensureProject(projectRoot);
      appState.syncFromHost();
      syncChatFromAppState();
      schedulePersistHost();
    });
  },
);

watch(
  () => chat.exportSnapshot(),
  () => {
    schedulePersistHost();
    if (!appState.isLoaded) return;
    for (const tab of chat.tabs) {
      if (tab.kind !== "chat") continue;
      appState.upsertFromChatTab({
        id: tab.id,
        title: tab.title,
        kind: "chat",
        messages: tab.messages,
        lastError: tab.lastError ?? null,
        lastTaskId: tab.activeTaskId ?? tab.lastTaskId ?? null,
      });
    }
    schedulePartnerTrayRefresh();
  },
  { deep: true },
);

watch(
  () => [
    appState.sessions,
    settings.locale,
    chat.tabs.map((tab) => `${tab.id}:${tab.isAgentRunning ? 1 : 0}:${tab.title}`).join("|"),
  ],
  () => schedulePartnerTrayRefresh(),
  { deep: true },
);

watch(
  () => preview.exportSnapshot(),
  () => schedulePersistHost(),
  { deep: true },
);

watch([explorerOpen, editorOpen], () => {
  persistLayout();
  schedulePersistHost();
});

// Opening a file/log/diff should expand a collapsed right workspace and widen if cramped.
watch(
  () => preview.revealToken,
  () => {
    if (!previewOpen.value) {
      setPreviewOpen(true);
    }
    explorerOpen.value = true;
    editorOpen.value = true;
    ensureComfortablePreviewWidth();
  },
);

watch([terminalOpen, terminalHeight], () => {
  persistLayout();
  schedulePersistHost();
});
</script>

<template>
  <div class="app-shell">
    <SidecarUnavailableDialog
      :visible="Boolean(sidecarDialog)"
      :error="sidecarDialog?.error"
      :needs-node-install="sidecarDialog?.needsNodeInstall"
      @dismiss="sidecarDialog = null"
    />
    <ImageLightbox />
    <QuickOpenDialog @jump-message="onJumpMessage" />
    <div
      class="main-layout"
      :class="{
        'has-left': leftOpen,
        'has-preview': previewVisible,
        'has-terminal': terminalOpen,
        resizing: resizing,
        'resizing-terminal': resizing === 'terminal',
      }"
      :style="layoutStyle"
    >
      <LeftPanel
        v-if="leftOpen"
        class="panel left"
        @collapse="setLeftOpen(false)"
      />
      <div
        v-else
        class="panel-rail left-rail"
      >
        <PanelToggleButton
          side="left"
          :open="false"
          :title="panelToggleText.expandLeft"
          @click="setLeftOpen(true)"
        />
      </div>
      <div
        v-if="leftOpen"
        class="resize-handle vertical"
        :class="{ active: resizing === 'left' }"
        role="separator"
        aria-orientation="vertical"
        @pointerdown="startResize('left', $event)"
      />
      <div
        v-else
        class="resize-handle vertical inert"
        aria-hidden="true"
      />
      <ChatPanel ref="chatPanelRef" class="panel center" />
      <div
        v-if="previewVisible"
        class="resize-handle vertical"
        :class="{ active: resizing === 'preview' }"
        role="separator"
        aria-orientation="vertical"
        @pointerdown="startResize('preview', $event)"
      />
      <div
        v-else
        class="resize-handle vertical inert"
        aria-hidden="true"
      />
      <PreviewPanel
        v-if="previewVisible"
        v-model:explorer-open="explorerOpen"
        v-model:editor-open="editorOpen"
        class="panel right"
        @collapse="setPreviewOpen(false)"
      />
      <div
        v-else-if="previewRailVisible"
        class="panel-rail right-rail"
      >
        <PanelToggleButton
          side="right"
          :open="false"
          :title="panelToggleText.expandPreview"
          @click="setPreviewOpen(true)"
        />
      </div>
    </div>
    <div
      v-show="terminalOpen"
      class="resize-handle horizontal"
      :class="{ active: resizing === 'terminal' }"
      role="separator"
      aria-orientation="horizontal"
      @pointerdown="startResize('terminal', $event)"
    />
    <div
      v-show="terminalOpen"
      class="terminal-host"
      :style="{ height: terminalOpen ? `${terminalHeight}px` : '0px' }"
    >
      <TerminalPanel />
    </div>
  </div>
</template>

<style scoped>
.app-shell {
  display: flex;
  flex-direction: column;
  height: 100%;
  border-top: 1px solid var(--border);
  background: var(--bg);
}

.main-layout {
  flex: 1;
  display: grid;
  min-height: 0;
  grid-template-columns:
    var(--left-w) 1px minmax(var(--center-min), 1fr) 1px var(--preview-w);
}

.terminal-host {
  flex-shrink: 0;
  min-height: 0;
  overflow: hidden;
}

.panel {
  min-height: 0;
  overflow: hidden;
}

.panel-rail {
  display: flex;
  align-items: flex-start;
  justify-content: center;
  min-width: 0;
  padding-top: 4px;
  background: var(--bg);
}

.left-rail {
  border-right: 1px solid var(--border);
}

.right-rail {
  border-left: 1px solid var(--border);
}

.resize-handle.inert {
  pointer-events: none;
  opacity: 0;
}

.resize-handle {
  position: relative;
  background: var(--border);
  opacity: 0.45;
  z-index: 1;
}

.resize-handle::after {
  content: "";
  position: absolute;
  inset: 0 -5px;
}

.resize-handle.vertical {
  cursor: col-resize;
}

.resize-handle.horizontal {
  height: 1px;
  cursor: row-resize;
  flex-shrink: 0;
}

.resize-handle.horizontal::after {
  inset: -5px 0;
}

.resize-handle:hover,
.resize-handle.active {
  background: var(--accent);
  opacity: 0.8;
}

.main-layout.resizing {
  cursor: col-resize;
  user-select: none;
}

.main-layout.resizing-terminal,
.app-shell:has(.resize-handle.horizontal.active) {
  cursor: row-resize;
  user-select: none;
}

/* Narrow windows: compress columns (override saved px widths). */
@media (max-width: 1024px) {
  .main-layout.has-left.has-preview {
    grid-template-columns:
      minmax(36px, min(180px, var(--left-w))) 1px minmax(220px, 1fr) 1px
      minmax(36px, min(360px, var(--preview-w)));
  }
}

@media (max-width: 720px) {
  .main-layout.has-left.has-preview {
    grid-template-columns:
      minmax(36px, min(150px, var(--left-w))) 1px minmax(180px, 1fr) 1px
      minmax(36px, min(280px, var(--preview-w)));
  }
}
</style>
