import { defineStore } from "pinia";
import { detectLanguage } from "@/preview/language";
import { moveTabById } from "@/utils/tab-reorder";
import type { PreviewTab } from "./preview-types.js";
export type { PreviewTab } from "./preview-types.js";
export {
  classifyFilePath,
  isBinaryFilePath,
  isCodeFilePath,
} from "./preview-types.js";
export type { FilePathKind } from "./preview-types.js";

const SNAPSHOT_VERSION = 1;

export interface PreviewSnapshot {
  version: number;
  activeTabId: string | null;
  tabs: PreviewTab[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeTab(value: unknown): PreviewTab | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.id !== "string" ||
    typeof value.title !== "string" ||
    typeof value.kind !== "string" ||
    typeof value.source !== "string"
  ) {
    return null;
  }
  if (
    !["html", "pdf", "image", "media", "code", "markdown"].includes(value.kind)
  ) {
    return null;
  }
  return {
    id: value.id,
    title: value.title,
    kind: value.kind,
    source: value.source,
    ...(typeof value.filePath === "string" ? { filePath: value.filePath } : {}),
    ...(typeof value.content === "string" ? { content: value.content } : {}),
    ...(typeof value.savedContent === "string"
      ? { savedContent: value.savedContent }
      : {}),
    ...(typeof value.isDirty === "boolean" ? { isDirty: value.isDirty } : {}),
    ...(typeof value.readOnly === "boolean"
      ? { readOnly: value.readOnly }
      : {}),
    ...(typeof value.languageId === "string"
      ? { languageId: value.languageId }
      : {}),
  } as PreviewTab;
}

function parseSnapshot(value: unknown): PreviewSnapshot | null {
  if (!isRecord(value) || !Array.isArray(value.tabs)) return null;
  const tabs = value.tabs
    .map(normalizeTab)
    .filter((tab): tab is PreviewTab => Boolean(tab));
  const activeTabId =
    typeof value.activeTabId === "string" &&
    tabs.some((tab) => tab.id === value.activeTabId)
      ? value.activeTabId
      : (tabs[0]?.id ?? null);
  return {
    version: SNAPSHOT_VERSION,
    activeTabId,
    tabs,
  };
}

export const usePreviewStore = defineStore("preview", {
  state: () => ({
    tabs: [] as PreviewTab[],
    activeTabId: null as string | null,
    lspEnabled: true,
    /** Bumped whenever UI should force-reveal the right preview panel. */
    revealToken: 0,
    /** Fullscreen chat/composer image preview. */
    imageLightbox: null as { src: string; alt: string } | null,
  }),
  actions: {
    /** Ask the shell to expand the collapsed right workspace panel. */
    requestReveal() {
      this.revealToken += 1;
    },
    openImageLightbox(src: string, alt = "") {
      this.imageLightbox = { src, alt };
    },
    closeImageLightbox() {
      this.imageLightbox = null;
    },
    openTab(tab: PreviewTab) {
      const existing = this.tabs.find((item) => item.id === tab.id);
      if (!existing) {
        this.tabs.push(tab);
      } else {
        Object.assign(existing, tab);
      }
      this.activeTabId = tab.id;
      this.requestReveal();
    },
    /** Focus an already-open code tab; returns false when the file is not open. */
    focusCodeFile(filePath: string): boolean {
      const id = `code:${filePath}`;
      const existing = this.tabs.find((item) => item.id === id);
      if (!existing) return false;
      this.activeTabId = id;
      this.requestReveal();
      return true;
    },
    /** Focus an already-open preview tab for this path, code or image. */
    focusFile(filePath: string): boolean {
      const existing = this.tabs.find(
        (item) =>
          item.id === `code:${filePath}` || item.id === `image:${filePath}`
      );
      if (!existing) return false;
      this.activeTabId = existing.id;
      this.requestReveal();
      return true;
    },
    openCodeFile(filePath: string, content: string) {
      const id = `code:${filePath}`;
      const existing = this.tabs.find((item) => item.id === id);
      if (existing?.isDirty) {
        this.activeTabId = id;
        this.requestReveal();
        return;
      }
      const title = filePath.split("/").pop() ?? filePath;
      this.openTab({
        id,
        title,
        kind: "code",
        source: filePath,
        filePath,
        content,
        savedContent: content,
        isDirty: false,
        languageId: detectLanguage(filePath, content),
      });
    },
    openDiffFile(filePath: string, content: string) {
      const title = `${filePath.split("/").pop() ?? filePath}.diff`;
      this.openTab({
        id: `diff:${filePath}`,
        title,
        kind: "code",
        source: `git-diff:${filePath}`,
        filePath: `${filePath}.diff`,
        content,
        savedContent: content,
        isDirty: false,
        readOnly: true,
        languageId: "plaintext",
      });
    },
    /** Preview an in-memory image (e.g. pasted/attached chat image). */
    openImagePreview(options: { id?: string; name: string; dataUrl: string }) {
      this.openImageLightbox(options.dataUrl, options.name || "");
    },
    /** Open an image file from disk as a preview tab. `dataUrl` may be empty. */
    openImageFile(filePath: string, dataUrl: string, byteSize?: number) {
      const title = filePath.split("/").pop() ?? filePath;
      this.openTab({
        id: `image:${filePath}`,
        title,
        kind: "image",
        source: filePath,
        filePath,
        content: dataUrl,
        isDirty: false,
        readOnly: true,
        ...(byteSize === undefined ? {} : { byteSize }),
      });
    },
    /** Fill in a restored image tab whose data URL was dropped on persist. */
    setImageFileContent(filePath: string, dataUrl: string, byteSize?: number) {
      const tab = this.tabs.find((item) => item.id === `image:${filePath}`);
      if (!tab || tab.kind !== "image") return;
      tab.content = dataUrl;
      if (byteSize !== undefined) tab.byteSize = byteSize;
    },
    updateCodeFileContent(filePath: string, content: string) {
      const tab = this.tabs.find((item) => item.id === `code:${filePath}`);
      if (!tab) return;
      tab.content = content;
      tab.isDirty = content !== (tab.savedContent ?? "");
    },
    markCodeFileSaved(filePath: string, content: string) {
      const tab = this.tabs.find((item) => item.id === `code:${filePath}`);
      if (!tab) return;
      tab.content = content;
      tab.savedContent = content;
      tab.isDirty = false;
    },
    refreshCleanCodeFile(filePath: string, content: string) {
      const tab = this.tabs.find((item) => item.id === `code:${filePath}`);
      if (!tab || tab.kind !== "code" || tab.isDirty) return;
      if (tab.savedContent === content && tab.content === content) return;
      tab.content = content;
      tab.savedContent = content;
      tab.isDirty = false;
    },
    closeTab(id: string) {
      this.tabs = this.tabs.filter((item) => item.id !== id);
      if (this.activeTabId === id) {
        this.activeTabId = this.tabs[0]?.id ?? null;
      }
    },
    /** Drag-reorder within the preview tab strip. */
    moveTab(tabId: string, insertionIndex: number) {
      const next = moveTabById(this.tabs, tabId, insertionIndex);
      if (next === this.tabs) return false;
      this.tabs = next;
      return true;
    },
    setLspEnabled(enabled: boolean) {
      this.lspEnabled = enabled;
    },
    reset() {
      this.tabs = [];
      this.activeTabId = null;
    },
    exportSnapshot(): PreviewSnapshot {
      return {
        version: SNAPSHOT_VERSION,
        // Image data URLs are megabytes each and would bloat the persisted
        // app-state; the tab is re-read from `filePath` when it becomes active.
        tabs: this.tabs.map((tab) =>
          tab.kind === "image" && tab.filePath
            ? { ...tab, content: "" }
            : { ...tab }
        ),
        activeTabId: this.activeTabId,
      };
    },
    restoreSnapshot(snapshot: unknown): boolean {
      const parsed = parseSnapshot(snapshot);
      if (!parsed) {
        this.reset();
        return false;
      }
      this.tabs = parsed.tabs;
      this.activeTabId = parsed.activeTabId;
      return true;
    },
  },
});
