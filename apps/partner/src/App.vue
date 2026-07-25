<script setup lang="ts">
import { getCurrentWindow } from "@tauri-apps/api/window";
import { storeToRefs } from "pinia";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import LeftPanel from "@/components/left/LeftPanel.vue";
import ChatPanel from "@/components/chat/ChatPanel.vue";
import PreviewPanel from "@/components/preview/PreviewPanel.vue";
import { loadPartnerSessions, savePartnerSessions } from "@/bridge";
import { getSidecarInfo, type SidecarInfo } from "@/bridge/agent";
import { registerPartnerAppEvents } from "@/bridge/events";
import SidecarUnavailableDialog from "@/components/SidecarUnavailableDialog.vue";
import { registerPartnerShortcuts } from "@/shortcuts/partner-shortcuts";
import { useChatStore } from "@/stores/chat";
import { usePreviewStore } from "@/stores/preview";
import { useSessionStore } from "@/stores/session";
import { useModelCatalogStore } from "@/stores/model-catalog";
import { useSettingsStore } from "@/stores/settings";
import { useWorkspaceStore } from "@/stores/workspace";
import type { LayoutSnapshot } from "@/types";
import {
  selectPartnerWindowSnapshot,
  upsertPartnerWindowSnapshot,
} from "@/utils/partner-sessions";

const preview = usePreviewStore();
const chat = useChatStore();
const session = useSessionStore();
const settings = useSettingsStore();
const modelCatalog = useModelCatalogStore();
const workspace = useWorkspaceStore();
const { activeTabId } = storeToRefs(preview);
const { rootPath } = storeToRefs(workspace);
const sidecarDialog = ref<SidecarInfo | null>(null);
let colorSchemeMedia: MediaQueryList | undefined;

const LAYOUT_STORAGE_KEY_PREFIX = "partner:layout";
const DEFAULT_LEFT_WIDTH = 240;
const DEFAULT_PREVIEW_WIDTH = 420;
const MIN_LEFT_WIDTH = 200;
const MIN_PREVIEW_WIDTH = 320;
const MIN_CENTER_WIDTH = 360;

const leftWidth = ref(DEFAULT_LEFT_WIDTH);
const previewWidth = ref(DEFAULT_PREVIEW_WIDTH);
const resizing = ref<"left" | "preview" | null>(null);
const sessionsLoaded = ref(false);
const isRestoringSessions = ref(false);
const initialWindowId = getCurrentWindow().label || "main";
const currentWindowId = ref(initialWindowId);
let unregisterAppEvents: (() => void) | undefined;
let unregisterShortcuts: (() => void) | undefined;
let persistSessionsTimer: number | undefined;

session.setWindowId(initialWindowId);
workspace.setWindowId(initialWindowId);

const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max);

const layoutStyle = computed(() => ({
  "--left-w": `${leftWidth.value}px`,
  "--preview-w": `${previewWidth.value}px`,
  "--center-min": `${MIN_CENTER_WIDTH}px`,
}));

function readStoredNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function layoutStorageKey(windowId = currentWindowId.value): string {
  return `${LAYOUT_STORAGE_KEY_PREFIX}:${windowId}`;
}

function currentLayoutSnapshot(): LayoutSnapshot {
  return {
    leftWidth: leftWidth.value,
    previewWidth: previewWidth.value,
  };
}

function applyLayoutSnapshot(layout: LayoutSnapshot) {
  const viewportWidth = window.innerWidth;
  leftWidth.value = clamp(layout.leftWidth, MIN_LEFT_WIDTH, Math.floor(viewportWidth / 2));
  previewWidth.value = clamp(
    layout.previewWidth,
    MIN_PREVIEW_WIDTH,
    Math.floor(viewportWidth / 2),
  );
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
    applyLayoutSnapshot(currentLayoutSnapshot());
  } catch (error) {
    console.warn("[Layout] failed to restore layout:", error);
  }
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
    schedulePersistSessions();
  }
  resizing.value = null;
  window.removeEventListener("pointermove", onPointerMove);
  window.removeEventListener("pointerup", stopResize);
}

function stopPersistSessionsTimer() {
  if (persistSessionsTimer) {
    window.clearTimeout(persistSessionsTimer);
  }
  persistSessionsTimer = undefined;
}

function schedulePersistSessions() {
  if (!rootPath.value || !sessionsLoaded.value || isRestoringSessions.value) return;
  stopPersistSessionsTimer();
  persistSessionsTimer = window.setTimeout(() => {
    void persistSessions();
  }, 350);
}

async function persistSessions() {
  if (!rootPath.value || isRestoringSessions.value) return;
  try {
    const stored = await loadPartnerSessions(rootPath.value);
    const snapshot = upsertPartnerWindowSnapshot(stored, {
      windowId: currentWindowId.value,
      chat: chat.exportSnapshot(),
      preview: preview.exportSnapshot(),
      layout: currentLayoutSnapshot(),
      updatedAt: Date.now(),
    });
    await savePartnerSessions(rootPath.value, snapshot);
  } catch (error) {
    console.warn("[Session] failed to persist partner sessions:", error);
  }
}

async function restoreSessions(projectRoot: string) {
  sessionsLoaded.value = false;
  isRestoringSessions.value = true;
  stopPersistSessionsTimer();
  try {
    const snapshot = await loadPartnerSessions(projectRoot);
    const windowSnapshot = selectPartnerWindowSnapshot(snapshot, currentWindowId.value);
    if (windowSnapshot) {
      chat.restoreSnapshot(windowSnapshot.chat);
      preview.restoreSnapshot(windowSnapshot.preview);
      applyLayoutSnapshot(windowSnapshot.layout);
      persistLayout();
    } else {
      chat.resetToDefault();
      preview.reset();
    }
  } catch (error) {
    console.warn("[Session] failed to restore partner sessions:", error);
    chat.resetToDefault();
    preview.reset();
  } finally {
    isRestoringSessions.value = false;
    sessionsLoaded.value = true;
  }
}

function onPointerMove(event: PointerEvent) {
  const viewportWidth = window.innerWidth;
  if (resizing.value === "left") {
    leftWidth.value = clamp(event.clientX, MIN_LEFT_WIDTH, Math.floor(viewportWidth / 2));
    return;
  }
  if (resizing.value === "preview") {
    const nextWidth = viewportWidth - event.clientX;
    const maxWidth = Math.min(
      Math.floor(viewportWidth / 2),
      viewportWidth - leftWidth.value - MIN_CENTER_WIDTH,
    );
    previewWidth.value = clamp(nextWidth, MIN_PREVIEW_WIDTH, Math.max(MIN_PREVIEW_WIDTH, maxWidth));
  }
}

function startResize(target: "left" | "preview", event: PointerEvent) {
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

function onColorSchemeChange() {
  if (settings.theme === "system") {
    syncPartnerTheme();
  }
}

onMounted(async () => {
  restoreLayout();
  await settings.load();
  syncPartnerTheme();
  colorSchemeMedia = window.matchMedia("(prefers-color-scheme: light)");
  colorSchemeMedia.addEventListener("change", onColorSchemeChange);
  try {
    const sidecarInfo = await getSidecarInfo();
    showSidecarUnavailable(sidecarInfo);
  } catch (error) {
    console.warn("[App] failed to query sidecar status:", error);
  }
  await modelCatalog.loadProviders(workspace.rootPath || undefined);
  if (settings.provider.id) {
    void modelCatalog.ensureProviderModels(
      workspace.rootPath || undefined,
      settings.provider.id,
    );
  }
  unregisterShortcuts = registerPartnerShortcuts();
  unregisterAppEvents = await registerPartnerAppEvents({
    onOpenSettings: () => {
      chat.openSettingsTab();
    },
    onSidecarUnavailable: showSidecarUnavailable,
  });
});

onBeforeUnmount(() => {
  colorSchemeMedia?.removeEventListener("change", onColorSchemeChange);
  unregisterAppEvents?.();
  unregisterShortcuts?.();
  stopPersistSessionsTimer();
  if (rootPath.value && sessionsLoaded.value) {
    void persistSessions();
  }
  stopResize();
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

watch(
  rootPath,
  (projectRoot) => {
    if (!projectRoot) return;
    modelCatalog.reset();
    void settings.load(projectRoot);
    void modelCatalog.loadProviders(projectRoot, true);
    void restoreSessions(projectRoot);
  },
);

watch(
  () => chat.exportSnapshot(),
  () => schedulePersistSessions(),
  { deep: true },
);

watch(
  () => preview.exportSnapshot(),
  () => schedulePersistSessions(),
  { deep: true },
);
</script>

<template>
  <div class="app-shell">
    <SidecarUnavailableDialog
      :visible="Boolean(sidecarDialog)"
      :error="sidecarDialog?.error"
      :needs-node-install="sidecarDialog?.needsNodeInstall"
      @dismiss="sidecarDialog = null"
    />
    <div
      class="main-layout"
      :class="{ 'has-preview': activeTabId, resizing: resizing }"
      :style="layoutStyle"
    >
      <LeftPanel class="panel left" />
      <div
        class="resize-handle vertical"
        :class="{ active: resizing === 'left' }"
        role="separator"
        aria-orientation="vertical"
        @pointerdown="startResize('left', $event)"
      />
      <ChatPanel class="panel center" />
      <div
        v-if="activeTabId"
        class="resize-handle vertical"
        :class="{ active: resizing === 'preview' }"
        role="separator"
        aria-orientation="vertical"
        @pointerdown="startResize('preview', $event)"
      />
      <PreviewPanel v-if="activeTabId" class="panel right" />
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
  grid-template-columns: var(--left-w) 1px minmax(var(--center-min), 1fr);
}

.main-layout.has-preview {
  grid-template-columns:
    var(--left-w) 1px minmax(var(--center-min), 1fr) 1px var(--preview-w);
}

.panel {
  min-height: 0;
  overflow: hidden;
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

.resize-handle:hover,
.resize-handle.active {
  background: var(--accent);
  opacity: 0.8;
}

.main-layout.resizing {
  cursor: col-resize;
  user-select: none;
}

/* Narrow windows: keep preview, compress columns (override saved px widths). */
@media (max-width: 1024px) {
  .main-layout {
    grid-template-columns: minmax(140px, min(200px, var(--left-w))) 1px minmax(240px, 1fr);
  }

  .main-layout.has-preview {
    grid-template-columns:
      minmax(120px, min(180px, var(--left-w))) 1px minmax(220px, 1fr) 1px
      minmax(200px, min(280px, var(--preview-w)));
  }
}

@media (max-width: 720px) {
  .main-layout {
    grid-template-columns: minmax(120px, min(160px, var(--left-w))) 1px minmax(200px, 1fr);
  }

  .main-layout.has-preview {
    grid-template-columns:
      minmax(100px, min(150px, var(--left-w))) 1px minmax(180px, 1fr) 1px
      minmax(160px, min(240px, var(--preview-w)));
  }
}
</style>
